import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';

const record = (id, name) => ({ id, type: 'customer-database', value: { name,
  created_at: '2026-10-14T00:00:00.000Z' } });

test('watched record prefix revision survives cold open and ignores unrelated writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trillion-record-frontier-'));
  let host;
  try {
    const path = join(directory, 'owner.sqlite');
    host = sqliteHost(path);
    const first = openRecords(host.sql, { transaction: host.transaction, lazy: true });
    assert.equal(typeof first.readOwnFieldJson, 'function');
    first.write([{ id: 'setting:before-watch', type: 'setting', value: { value: 'before' } }]);
    assert.equal(host.sql.exec(`SELECT count(*) AS n FROM record_keys_meta
      WHERE key LIKE 'record-change-revision:%'`).toArray()[0].n, 0);
    const beginning = first.durableRevisionOf(['customer-database']);
    assert.deepEqual(JSON.parse(beginning)[0].revision, 0);
    assert.equal(host.sql.exec(`SELECT count(*) AS n FROM record_keys_meta
      WHERE key LIKE 'record-change-revision:%'`).toArray()[0].n, 1);
    first.write([{ id: 'setting:one', type: 'setting', value: { value: 'other' } }]);
    assert.equal(first.durableRevisionOf(['customer-database']), beginning);
    first.write([record('customer-database:one', 'One')]);
    const written = first.durableRevisionOf(['customer-database']);
    assert.notEqual(written, beginning);
    assert.equal(JSON.parse(written)[0].revision, 1);
    host.db.close(); host = sqliteHost(path);
    const reopened = openRecords(host.sql, { transaction: host.transaction });
    assert.equal(reopened.durableRevisionOf(['customer-database']), written);
    reopened.write([{ id: 'customer-database:one', type: 'customer-database', value: null }]);
    assert.equal(JSON.parse(reopened.durableRevisionOf(['customer-database']))[0].revision, 2);
    // Deleting a watched clock row is a physical reset, never a return to the
    // old zero descriptor that might still be held by an interrupted proof.
    host.sql.exec(`DELETE FROM record_keys_meta WHERE key=?`, 'record-change-revision:customer-database');
    const reset = reopened.durableRevisionOf(['customer-database']);
    assert.notEqual(reset, beginning);
    assert.notEqual(reset, written);
    assert.equal(JSON.parse(reset)[0].revision, 0);
  } finally { host?.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('failed watched counter write rolls back record data and invalidates same-owner memory', () => {
  const host = sqliteHost(':memory:');
  try {
    let reject = false;
    const sql = { exec(query, ...args) {
      if (reject && query.includes('UPDATE record_keys_meta') && JSON.parse(args[0]).includes('record-change-revision:customer-database'))
        throw new Error('injected frontier write failure');
      return host.sql.exec(query, ...args);
    } };
    const records = openRecords(sql, { transaction: host.transaction });
    const id = 'customer-database:one';
    records.write([record(id, 'Original')]);
    const before = records.durableRevisionOf(['customer-database']);
    assert.equal(records.read(id).name, 'Original');
    reject = true;
    assert.throws(() => records.write([record(id, 'Rejected')]), /injected frontier write failure/);
    reject = false;
    assert.equal(records.durableRevisionOf(['customer-database']), before);
    assert.equal(records.read(id).name, 'Original');
    const cold = openRecords(host.sql, { transaction: host.transaction });
    assert.equal(cold.read(id).name, 'Original');
    records.write([record(id, 'Committed')]);
    assert.equal(records.read(id).name, 'Committed');
    assert.notEqual(records.durableRevisionOf(['customer-database']), before);
  } finally { host.db.close(); }
});

test('older EEAF writes before registration and alternate canonical mutators advance only watched prefixes', () => {
  const host = sqliteHost(':memory:');
  try {
    setRecordEngine(host.sql, 'eeaf');
    const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
    const id = 'customer-database:old';
    records.write([record(id, 'First')]);
    const before = records.durableRevisionOf(['customer-database']);
    assert.equal(JSON.parse(before)[0].revision, 0);
    records.writeOwn(id, 'customer-database', { name: 'Second' });
    assert.equal(JSON.parse(records.durableRevisionOf(['customer-database']))[0].revision, 1);
    records.write([{ id: 'setting:two', type: 'setting', value: { value: 'other' } }]);
    assert.equal(JSON.parse(records.durableRevisionOf(['customer-database']))[0].revision, 1);
    records.write([{ id, type: 'customer-database', value: null }]);
    assert.equal(JSON.parse(records.durableRevisionOf(['customer-database']))[0].revision, 2);
  } finally { host.db.close(); }
});

test('record-log copy adoption and exact-field replacement advance the watched frontier', () => {
  const host = sqliteHost(':memory:');
  try {
    const records = openRecords(host.sql, { transaction: host.transaction });
    records.durableRevisionOf(['customer-database']);
    records.takeRecords([record('customer-database:copy', 'Copied')]);
    assert.equal(JSON.parse(records.durableRevisionOf(['customer-database']))[0].revision, 1);
    const changed = records.rewriteOwnFieldIfEqual('customer-database:copy','customer-database',
      'name','Copied',{deleted_at:'2026-10-14T01:00:00.000Z'});
    assert.equal(changed,true);
    assert.equal(records.read('customer-database:copy').name,undefined);
    assert.equal(JSON.parse(records.durableRevisionOf(['customer-database']))[0].revision, 2);
  } finally { host.db.close(); }
});

test('an unwatched legacy caller keeps writing but cannot register or mutate a watched clock without a transaction', () => {
  const host = sqliteHost(':memory:');
  try {
    const legacy = openRecords(host.sql);
    const id = 'customer-database:legacy';
    legacy.write([record(id, 'Before watch')]);
    assert.equal(legacy.read(id).name, 'Before watch');
    assert.throws(() => legacy.durableRevisionOf(['customer-database']), /transaction owner/);
    const owned = openRecords(host.sql,{transaction:host.transaction});
    const frontier = owned.durableRevisionOf(['customer-database']);
    assert.throws(() => legacy.write([record(id,'Blocked')]), /transaction owner/);
    assert.equal(owned.durableRevisionOf(['customer-database']),frontier);
    assert.equal(owned.read(id).name,'Before watch');
  }finally{host.db.close();}
});

test('warm multi-prefix writes advance only registered clocks once without metadata DDL on either engine', () => {
  for (const engine of ['eeaf', 'record-log']) {
    const host = sqliteHost(':memory:');
    try {
      setRecordEngine(host.sql, engine);
      const calls = [];
      const sql = { exec(query, ...args) {
        calls.push({ query, args });
        return host.sql.exec(query, ...args);
      } };
      const records = openRecords(sql, { transaction: host.transaction, hash: text => text });
      records.write([record('customer-database:warm', 'Warm')]);
      records.durableRevisionOf(['customer-database', 'setting']);
      calls.length = 0;
      records.write([
        record('customer-database:one', 'One'),
        record('customer-database:two', 'Two'),
        { id: 'setting:one', type: 'setting', value: { value: 'Other' } },
        record('unwatched:one', 'Unwatched'),
      ]);
      assert.equal(calls.filter(call => call.query.includes('CREATE TABLE IF NOT EXISTS record_keys_meta')).length, 0, engine);
      const advances = calls.filter(call => call.query.includes('UPDATE record_keys_meta'));
      assert.equal(advances.length, 1, engine);
      assert.equal(advances[0].args.length, 1);
      assert.deepEqual(JSON.parse(advances[0].args[0]).sort(),
        ['record-change-revision:customer-database', 'record-change-revision:setting', 'record-change-revision:unwatched'], engine);
      assert.equal(host.sql.exec('SELECT count(*) AS n FROM record_keys_meta WHERE key=?',
        'record-change-revision:unwatched').toArray()[0].n, 0, 'a write never registers an unwatched clock');
      assert.deepEqual(JSON.parse(records.durableRevisionOf(['customer-database', 'setting'])).map(frontier => frontier.revision),
        [1, 1], engine);
      assert.equal(records.read('customer-database:one').name, 'One');
      assert.equal(records.read('customer-database:two').name, 'Two');
      assert.equal(records.read('setting:one').value, 'Other');
      assert.equal(records.read('unwatched:one').name, 'Unwatched');
    } finally { host.db.close(); }
  }
});

test('a physically missing metadata table is recreated once before retrying the same complete prefix batch', () => {
  const host = sqliteHost(':memory:');
  try {
    setRecordEngine(host.sql, 'eeaf');
    const calls = [];
    const sql = { exec(query, ...args) {
      calls.push({ query, args });
      return host.sql.exec(query, ...args);
    } };
    const records = openRecords(sql, { transaction: host.transaction, hash: text => text });
    const id = 'customer-database:one';
    records.write([record(id, 'Original')]);
    const before = records.durableRevisionOf(['customer-database', 'setting']);
    host.sql.exec('DROP TABLE record_keys_meta');
    calls.length = 0;
    records.write([
      record(id, 'After reset'),
      { id: 'setting:one', type: 'setting', value: { value: 'Other' } },
    ]);
    assert.equal(calls.filter(call => call.query.includes('CREATE TABLE IF NOT EXISTS record_keys_meta')).length, 1);
    const advances = calls.filter(call => call.query.includes('UPDATE record_keys_meta'));
    assert.equal(advances.length, 2);
    assert.deepEqual(advances[0].args, advances[1].args, 'the missing-table retry keeps every original prefix');
    assert.deepEqual(JSON.parse(advances[0].args[0]),
      ['record-change-revision:customer-database', 'record-change-revision:setting']);
    assert.equal(records.read(id).name, 'After reset');
    assert.equal(records.read('setting:one').value, 'Other');
    const reset = records.durableRevisionOf(['customer-database', 'setting']);
    assert.notEqual(reset, before, 'a dropped clock never reuses an interrupted proof');
    assert.deepEqual(JSON.parse(reset).map(frontier => frontier.revision), [0, 0]);
    calls.length = 0;
    records.write([record(id, 'Warm again')]);
    assert.equal(calls.filter(call => call.query.includes('CREATE TABLE IF NOT EXISTS record_keys_meta')).length, 0);
    assert.equal(JSON.parse(records.durableRevisionOf(['customer-database']))[0].revision, 1);
  } finally { host.db.close(); }
});

test('other missing tables and column or storage failures never trigger metadata recovery', () => {
  const host = sqliteHost(':memory:');
  try {
    let rejection = null;
    const calls = [];
    const sql = { exec(query, ...args) {
      calls.push({ query, args });
      if (rejection && query.includes('UPDATE record_keys_meta')) throw new Error(rejection);
      return host.sql.exec(query, ...args);
    } };
    const records = openRecords(sql, { transaction: host.transaction });
    const id = 'customer-database:one';
    records.write([record(id, 'Original')]);
    const before = records.durableRevisionOf(['customer-database']);
    for (const failure of ['no such table: another_table', 'no such table: record_keys_meta_other',
      'no such table: record_keys_meta-other', 'no such table: record_keys_meta.schema',
      'no such column: value', 'database is locked']) {
      calls.length = 0; rejection = failure;
      assert.throws(() => records.write([record(id, 'Rejected')]), error => error.message === failure);
      rejection = null;
      assert.equal(calls.filter(call => call.query.includes('CREATE TABLE IF NOT EXISTS record_keys_meta')).length, 0, failure);
      assert.equal(records.read(id).name, 'Original');
      assert.equal(records.durableRevisionOf(['customer-database']), before);
      assert.equal(openRecords(host.sql, { transaction: host.transaction }).read(id).name, 'Original');
    }
  } finally { host.db.close(); }
});

test('a failed missing-table retry rolls back record bytes and the whole watched prefix batch before recovery', () => {
  const host = sqliteHost(':memory:');
  try {
    let failing = false, missingReturned = false;
    const calls = [];
    const sql = { exec(query, ...args) {
      calls.push({ query, args });
      if (failing && query.includes('UPDATE record_keys_meta')) {
        if (!missingReturned) {
          missingReturned = true;
          throw new Error('SQLITE_ERROR: no such table: record_keys_meta \n');
        }
        // Let the actual multi-row increment happen, then refuse the owner
        // transaction. Neither the record bytes nor either clock may survive.
        host.sql.exec(query, ...args);
        throw new Error('injected retry failure');
      }
      return host.sql.exec(query, ...args);
    } };
    const records = openRecords(sql, { transaction: host.transaction });
    const id = 'customer-database:one';
    records.write([record(id, 'Original'), { id: 'setting:one', type: 'setting', value: { value: 'Original' } }]);
    const before = records.durableRevisionOf(['customer-database', 'setting']);
    calls.length = 0; failing = true;
    assert.throws(() => records.write([record(id, 'Rejected'), { id: 'setting:one', type: 'setting', value: { value: 'Rejected' } }]),
      /injected retry failure/);
    failing = false;
    assert.equal(calls.filter(call => call.query.includes('CREATE TABLE IF NOT EXISTS record_keys_meta')).length, 1);
    const advances = calls.filter(call => call.query.includes('UPDATE record_keys_meta'));
    assert.equal(advances.length, 2);
    assert.deepEqual(advances[0].args, advances[1].args);
    assert.equal(records.durableRevisionOf(['customer-database', 'setting']), before);
    assert.equal(records.read(id).name, 'Original');
    assert.equal(records.read('setting:one').value, 'Original');
    const cold = openRecords(host.sql, { transaction: host.transaction });
    assert.equal(cold.durableRevisionOf(['customer-database', 'setting']), before);
    assert.equal(cold.read(id).name, 'Original');
    assert.equal(cold.read('setting:one').value, 'Original');
    records.write([record(id, 'Committed'), { id: 'setting:one', type: 'setting', value: { value: 'Committed' } }]);
    assert.deepEqual(JSON.parse(records.durableRevisionOf(['customer-database', 'setting'])).map(frontier => frontier.revision),
      [1, 1]);
  } finally { host.db.close(); }
});
