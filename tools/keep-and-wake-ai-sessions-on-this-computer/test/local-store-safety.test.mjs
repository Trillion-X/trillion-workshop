// The local store's safety nets (src/local-store-safety.mjs): rolling snapshots, a copy before a change, restore with a copy first.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { copyBeforeChange, restoreSnapshot, snapshotIfDue, snapshotsOf } from '../src/local-store-safety.mjs';
import { localStore } from '../src/local-store.mjs';

const config = { snapshots_kept: 2, min_interval_hours: 24, before_change_kept: 1, folder_suffix: '.snapshots', before_folder_suffix: '.before', automatic: true };
const rowsOf = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT v FROM t ORDER BY v').all().map(row => row.v); } finally { db.close(); } };

test('snapshots are due daily, keep only the newest few, and a restore copies what it replaces first', () => {
  const folder = mkdtempSync(join(tmpdir(), 'local-safety-'));
  const file = join(folder, 'store.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'one\')');
  let clock = Date.now();
  const now = () => clock;
  const first = snapshotIfDue(db, file, { now, config });
  assert.ok(first);
  assert.equal(snapshotIfDue(db, file, { now, config }), null, 'not due again the same day');
  for (const day of [1, 2, 3]) { clock += (day * 25) * 3_600_000; db.exec(`INSERT INTO t VALUES ('day ${day}')`); }
  // mtime is real time here, so age the first snapshot's slot by taking fresh ones past the interval.
  const config0 = { ...config, min_interval_hours: 0 };
  snapshotIfDue(db, file, { now, config: config0 });
  clock += 1000; snapshotIfDue(db, file, { now, config: config0 });
  clock += 1000; snapshotIfDue(db, file, { now, config: config0 });
  assert.equal(snapshotsOf(file, config).length, 2, 'only the newest two stay');
  const newest = snapshotsOf(file, config)[0];
  assert.deepEqual(rowsOf(newest), ['day 1', 'day 2', 'day 3', 'one']);
  const migrated = copyBeforeChange(db, file, 'v2 migrate', { now, config });
  assert.ok(migrated.endsWith('-v2-migrate.sqlite'));
  db.exec('DELETE FROM t');
  db.close();
  const restored = restoreSnapshot(file, newest, { now, config });
  assert.deepEqual(rowsOf(file), ['day 1', 'day 2', 'day 3', 'one']);
  assert.deepEqual(rowsOf(restored.before), [], 'the store it replaced was kept first');
  assert.ok(!existsSync(file + '-wal'));
  assert.throws(() => restoreSnapshot(file, join(folder, 'missing.sqlite'), { now, config }));
  assert.deepEqual(rowsOf(file), ['day 1', 'day 2', 'day 3', 'one'], 'a bad snapshot replaced nothing');
});

test('opening the store on a computer takes a due snapshot beside it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'local-safety-open-'));
  const file = join(folder, 'decisions.sqlite');
  localStore(file);
  assert.equal(readdirSync(`${file}.snapshots`).length, 1);
  localStore(file);
  assert.equal(readdirSync(`${file}.snapshots`).length, 1, 'a second open the same day adds none');
});

test('opening a store whose kept shape is not this code\'s copies it first, once, and records the new shape', () => {
  const folder = mkdtempSync(join(tmpdir(), 'local-safety-shape-'));
  const file = join(folder, 'decisions.sqlite');
  const first = localStore(file);
  assert.equal(existsSync(`${file}.before`), false, 'a new store has nothing to copy');
  const stamped = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); } };
  const shape = stamped();
  assert.ok(shape > 0, 'the shape is recorded once the tables are made');
  localStore(file);
  assert.equal(existsSync(`${file}.before`), false, 'the same shape copies nothing');
  // An older release's store: a different kept shape.
  const old = new DatabaseSync(file); old.exec('PRAGMA user_version = 7'); old.close();
  localStore(file);
  const copies = readdirSync(`${file}.before`);
  assert.equal(copies.length, 1);
  assert.match(copies[0], new RegExp(`shape-7-to-${shape}\\.sqlite$`));
  assert.equal(stamped(), shape);
  localStore(file);
  assert.equal(readdirSync(`${file}.before`).length, 1, 'recorded, so not copied again');
  void first;
});
