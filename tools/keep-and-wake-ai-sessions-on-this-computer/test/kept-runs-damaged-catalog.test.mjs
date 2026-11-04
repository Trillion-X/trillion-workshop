// A key space whose pages were removed from under its catalogue (the prune of store f281a627, 2026-10-20 ~10:15 PM PDT, emptied
// record_keys_big, record_keys_meta and run tables the catalogue still listed) throws when it opens; its owner brings it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns, repairKeptRunsCatalog } from '../parts/record-log/do-work/kept-runs.mjs';
import { repairRecordLogCatalog, recordLogOwnsTable } from '../parts/record-log/do-work/record-log-store.mjs';

const settings = { prefix: 'record_keys', page_bytes: 256, big_bytes: 64, memtable_bytes: 8192, fan_in: 8, max_runs: 8 };
const key = at => `k${String(at).padStart(4, '0')}`;
const value = at => ({ at, text: 'v'.repeat(120) });
const rows = (host, query, ...params) => [...host.sql.exec(query, ...params)];
const count = (host, table) => rows(host, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;

// Four runs, large values in the big table: the shape of the catalogue before the prune.
function keySpace() {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, { transaction: host.transaction, ...settings });
  const space = open();
  for (let run = 0; run < 4; run += 1) {
    for (let at = run * 40; at < run * 40 + 40; at += 1) space.put(key(at), value(at));
    space.flush({ covered: { at: run + 1 } });
  }
  return { host, open };
}
const runNumbers = host => rows(host, 'SELECT run FROM record_keys_runs ORDER BY run').map(row => row.run);

// What the prune did, in its order: the big table and the metadata emptied, the first runs emptied, one run half emptied.
function damage(host) {
  const [first, second, third] = runNumbers(host);
  host.sql.exec('DELETE FROM record_keys_big');
  host.sql.exec('DELETE FROM record_keys_meta');
  host.sql.exec(`DELETE FROM record_keys_run_${first}`);
  host.sql.exec(`DELETE FROM record_keys_run_${second}`);
  host.sql.exec(`DELETE FROM record_keys_run_${third} WHERE page IN (SELECT page FROM record_keys_run_${third} WHERE page >= 0 ORDER BY page LIMIT 1)`);
  return [first, second, third];
}

test('a catalogue naming runs whose pages are gone makes the key space throw when it is read, and its owner brings it back to one that opens', () => {
  const { host, open } = keySpace();
  assert.ok(runNumbers(host).length >= 3, 'the fixture holds several runs');
  const damaged = damage(host);
  assert.throws(() => { const space = open(); for (let at = 0; at < 160; at += 1) space.get(key(at)); }, /Page \d+ of record_keys_run_\d+ is missing/);
  const answer = repairRecordLogCatalog(host.sql, { transaction: host.transaction });
  assert.equal(answer.repaired, true);
  for (const run of damaged) assert.ok(answer.damaged.includes(run), `run ${run} is named damaged`);
  assert.equal(count(host, 'record_keys_runs'), 0);
  assert.deepEqual(rows(host, "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'record_keys_run_*'"), [], 'no run table is left');
  for (const table of ['record_keys_meta', 'record_keys_big', 'record_keys_big_drops']) assert.equal(count(host, table), 0);
  const space = open();
  assert.equal(space.get(key(1)), undefined, 'it opens as a new key space');
  space.put(key(1), value(1));
  space.flush({ covered: { at: 1 } });
  assert.deepEqual(open().get(key(1)), value(1), 'and keeps what is written to it afterwards');
  assert.deepEqual(repairRecordLogCatalog(host.sql, { transaction: host.transaction }), { repaired: false, damaged: [], dropped: 0 }, 'a second repair changes nothing');
});

test('a key space with no damage is left whole, and so is a database with none', () => {
  const { host, open } = keySpace();
  const before = rows(host, 'SELECT * FROM record_keys_runs ORDER BY run');
  assert.deepEqual(repairKeptRunsCatalog(host.sql, { transaction: host.transaction, prefix: 'record_keys' }), { repaired: false, damaged: [], dropped: 0 });
  assert.deepEqual(rows(host, 'SELECT * FROM record_keys_runs ORDER BY run'), before);
  assert.deepEqual(open().get(key(5)), value(5), 'its keys still answer');
  const empty = sqliteHost(':memory:');
  assert.deepEqual(repairRecordLogCatalog(empty.sql, { transaction: empty.transaction }), { repaired: false, damaged: [], dropped: 0 });
});

test('runs whose metadata was emptied are repaired too, since nothing vouches for the position they cover', () => {
  const { host } = keySpace();
  host.sql.exec('DELETE FROM record_keys_meta');
  assert.equal(repairRecordLogCatalog(host.sql, { transaction: host.transaction }).repaired, true);
  assert.equal(count(host, 'record_keys_runs'), 0);
});

test('the record log names its tables, so no prune removes rows from them piecemeal', () => {
  for (const name of ['record_log', 'record_log_sealed_1', 'record_keys_runs', 'record_keys_run_7', 'record_keys_big', 'record_keys_meta', '_record_tables_kinds', 'rt_ab12', 'record_copy_positions', 'record_erasable_keys'])
    assert.equal(recordLogOwnsTable(name), true, `${name} is the record log's`);
  for (const name of ['activity_g15', 'model_answers', 'public_app_installations', 'namespace_files', 'billing_ledger'])
    assert.equal(recordLogOwnsTable(name), false, `${name} is not`);
});

test('a record store whose key space was damaged opens again after the repair and replays its log (the store of the prune)', async () => {
  const { decisionStore } = await import('../src/decision-store.mjs');
  const host = sqliteHost(':memory:');
  const open = () => decisionStore(host.sql, { transaction: host.transaction });
  let store = open();
  for (let at = 0; at < 600; at += 100) {
    store.eeaf.write(Array.from({ length: 100 }, (_, n) => ({ id: `message:kept-${at + n}`, type: 'message', value: { text: `kept ${at + n} ${'x'.repeat(400)}` } })), { actor: { by: 'fixture' } });
    store.eeaf.checkpoint();
  }
  assert.equal(store.eeaf.count('message'), 600);
  const runs = runNumbers(host);
  assert.ok(runs.length >= 1, 'the store keeps runs');
  host.sql.exec('DELETE FROM record_keys_big');
  host.sql.exec('DELETE FROM record_keys_meta');
  for (const run of runs) host.sql.exec(`DELETE FROM record_keys_run_${run}`);
  assert.throws(() => { const damaged = open(); damaged.eeaf.count('message'); damaged.eeaf.read('message:kept-1'); }, /is missing/);
  assert.equal(repairRecordLogCatalog(host.sql, { transaction: host.transaction }).repaired, true);
  store = open();
  assert.equal(store.eeaf.count('message'), 600, 'the log is replayed into the new key space');
  assert.ok(store.eeaf.read('message:kept-599')?.text.startsWith('kept 599'), 'a record answers from the rebuilt key space');
});

// The tables the prune emptied before it reached the record log's runs, and the live duties it never reached.
const EMPTIED_BEFORE_THE_LOG = ['_record_tables_fields', '_record_tables_history', '_record_tables_indexes', '_record_tables_kinds', 'account_app_created_sites', 'account_app_records',
  'activity_counts_g15', 'activity_counts_g16', 'activity_g15', 'activity_g16', 'activity_links_g15', 'activity_links_g16', 'ai_space_projection_pending', 'asks_for_your_ais',
  'asks_for_your_ais_work', 'file_words_cursor', 'file_words_marks', 'held_values', 'history_chain', 'live_tool_source_reads', 'local_choice_observation_window',
  'local_choice_observations', 'mcp_event_deliveries', 'mcp_event_verified', 'model_answers', 'model_spend', 'model_waits', 'outside_readings', 'public_app_installations',
  'public_app_page_views', 'public_app_submission_index', 'public_app_visitor_records', 'recent_file_uses', 'record_copy_positions', 'record_erasable_keys'];
const LIVE_DUTIES = ['billing_ledger', 'refresh_answers', 'grant_copies', 'notification_read', 'operational_state', 'decision_call_payloads', 'sign_in_use', 'ai_use', 'account_control'];

test('a store emptied exactly as the prune left f281a627 (35 tables, big, meta, 19 runs, one run partly) opens after the repair and answers its live duties', async () => {
  const { decisionStore } = await import('../src/decision-store.mjs');
  const host = sqliteHost(':memory:');
  for (const name of [...EMPTIED_BEFORE_THE_LOG.filter(name => !recordLogOwnsTable(name) && name !== 'history_chain'), ...LIVE_DUTIES]) {
    host.sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, value TEXT)`);
    host.sql.exec(`INSERT OR IGNORE INTO ${name} VALUES ('a', 'kept')`);
  }
  const open = () => decisionStore(host.sql, { transaction: host.transaction });
  let store = open();
  for (let at = 0; at < 1200; at += 100) {
    store.eeaf.write(Array.from({ length: 100 }, (_, n) => ({ id: `message:kept-${at + n}`, type: 'message', value: { text: `kept ${at + n} ${'x'.repeat(300)}` } })), { actor: { by: 'fixture' } });
    store.eeaf.checkpoint();
  }
  const runs = runNumbers(host);
  assert.ok(runs.length >= 2, 'the store keeps several runs');
  // In the prune's order: the tables before the log, big, meta, the first runs whole, the next run partly.
  for (const name of EMPTIED_BEFORE_THE_LOG) if (rows(host, 'SELECT 1 FROM sqlite_master WHERE name = ?', name).length) host.sql.exec(`DELETE FROM ${name}`);
  host.sql.exec('DELETE FROM record_keys_big');
  host.sql.exec('DELETE FROM record_keys_meta');
  for (const run of runs.slice(0, -1)) host.sql.exec(`DELETE FROM record_keys_run_${run}`);
  const last = runs.at(-1);
  host.sql.exec(`DELETE FROM record_keys_run_${last} WHERE page IN (SELECT page FROM record_keys_run_${last} WHERE page >= 0 ORDER BY page LIMIT 1)`);
  assert.throws(() => { const damaged = open(); damaged.eeaf.count('message'); damaged.eeaf.read('message:kept-3'); }, /is missing/);
  const answer = repairRecordLogCatalog(host.sql, { transaction: host.transaction });
  assert.equal(answer.repaired, true);
  assert.deepEqual(answer.damaged.sort((a, b) => a - b), runs, 'every listed run is named');
  store = open();
  assert.equal(store.eeaf.count('message'), 1200, 'the store opens and the log answers every record');
  assert.ok(store.eeaf.read('message:kept-1199')?.text.startsWith('kept 1199'));
  store.eeaf.write([{ id: 'message:after', type: 'message', value: { text: 'written after the repair' } }], { actor: { by: 'fixture' } });
  assert.equal(open().eeaf.count('message'), 1201, 'it takes writes and keeps them');
  for (const name of LIVE_DUTIES) assert.deepEqual(rows(host, `SELECT id, value FROM ${name}`).map(row => ({ ...row })), [{ id: "a", value: "kept" }], `${name}, a live duty, is as it was`);
});
