// test/namespace-names-promised.test.mjs
//
// A file sent again under the name a kept file already has is promised that name (namespace-store.mjs
// namespace_names_promised): the kept file keeps it until the upload finishes, so a second send that is stopped, or that
// never finishes, cannot leave the kept file with no name (Sam's C9506S03.MP4 lost its only name this way,
// 2026-10-04). A name given to anything else is no longer promised; a name lent by an earlier version goes back to its
// kept file when the store opens; and the kept files no name points at are counted (unnamed), apart from those set
// aside in Recently Deleted or Archived.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

const KEPT = `1f:${'a'.repeat(64)}`;
const OTHER = `1f:${'b'.repeat(64)}`;
const NAME = '/Recordings/SUB/C9506S03.MP4';
const nameOf = (sql, name) => sql.exec('SELECT identity FROM namespace_names WHERE name = ?', name).toArray()[0]?.identity ?? null;
const promises = sql => sql.exec('SELECT COUNT(*) AS n FROM namespace_names_promised').toArray()[0].n;

function kept(sql, identity, byteLength = 10) {
  sql.exec("INSERT INTO namespace_files (identity, byte_length, media_type, origin, key, part_bytes, stored_at, checked_at) VALUES (?, ?, 'video/mp4', 'test', '', 0, ?, ?)", identity, byteLength, new Date().toISOString(), new Date().toISOString());
}
function upload(store, growing) {
  store.startGrowing({ growing, byte_length: 10, media_type: 'video/mp4', origin: 'test', aliases: [] });
  return growing;
}
function arrive(sql, growing, chunk) {
  sql.exec('INSERT INTO namespace_spans (file, ordinal, offset, length, chunk) VALUES (?, 0, 0, 10, ?)', growing, chunk);
  sql.exec("INSERT INTO namespace_chunks (chunk, byte_length, origin, key, stored_at) VALUES (?, 10, 'test', 'k', ?) ON CONFLICT(chunk) DO NOTHING", chunk, new Date().toISOString());
}

test('a second send of a kept file never takes its name until it finishes, stopped or left unfinished', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  kept(sql, KEPT);
  store.putNames([{ name: NAME, identity: KEPT }]);
  const again = upload(store, `up:${'1'.repeat(32)}`);
  assert.deepEqual(store.putNames([{ name: NAME, identity: again }]).unnamed_uploads, []);
  assert.equal(nameOf(sql, NAME), KEPT, 'while it uploads, the kept file still has its name');
  assert.equal(store.unnamed().count, 0);
  assert.deepEqual(store.unfinishedGrowing().map(row => row.names), [[NAME]], 'the upload lists the name it will get');
  store.cancelGrowing(again);
  assert.equal(nameOf(sql, NAME), KEPT, 'stopped, the kept file still has its name');
  assert.equal(promises(sql), 0);
});

test('a finished send takes the name; a name given elsewhere, or sent again, is no longer promised', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  kept(sql, KEPT);
  kept(sql, OTHER);
  store.putNames([{ name: NAME, identity: KEPT }]);
  const first = upload(store, `up:${'2'.repeat(32)}`);
  store.putNames([{ name: NAME, identity: first }]);
  // The same name asked for by a newer send: the earlier send has no name left, for the caller to stop.
  const second = upload(store, `up:${'3'.repeat(32)}`);
  assert.deepEqual(store.putNames([{ name: NAME, identity: second }]).unnamed_uploads, [first]);
  store.cancelGrowing(first);
  arrive(sql, second, `1f:${'c'.repeat(64)}`);
  assert.equal(store.finishGrowing(second, `1f:${'c'.repeat(64)}`, 'attested').error, undefined);
  assert.equal(nameOf(sql, NAME), `1f:${'c'.repeat(64)}`, 'a finished upload takes the name');
  assert.equal(promises(sql), 0);

  // The person names other bytes with it while a send is under way: the send gets nothing.
  const third = upload(store, `up:${'4'.repeat(32)}`);
  store.putNames([{ name: NAME, identity: third }]);
  assert.deepEqual(store.putNames([{ name: NAME, identity: OTHER }]).unnamed_uploads, [third]);
  assert.equal(promises(sql), 0);
  assert.equal(nameOf(sql, NAME), OTHER);
});

test('conditional names preserve both writers and reject a stale edit or partial move', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  kept(sql, KEPT);
  kept(sql, OTHER);
  const third = `1f:${'d'.repeat(64)}`;
  kept(sql, third);
  store.putNames([{ name: NAME, identity: KEPT, byte_length: 10 }]);
  assert.equal(store.putNames([{ name: NAME, identity: OTHER, expected_identity: KEPT }]).named, 1);
  const stale = store.putNames([{ name: NAME, identity: third, expected_identity: KEPT }]);
  assert.deepEqual(stale.conflicts, [{ name: NAME, expected_identity: KEPT, current_identity: OTHER }]);
  assert.equal(stale.named, 0);
  assert.equal(nameOf(sql, NAME), OTHER);
  assert.ok(store.locate(third), 'the rejected writer still owns its bytes by content identity');

  const taken = '/Recordings/SUB/taken.mp4';
  store.putNames([{ name: taken, identity: KEPT }]);
  const partial = store.putNames([{ name: taken, identity: OTHER, expected_identity: null }, { name: NAME, remove: true, expected_identity: OTHER }]);
  assert.equal(partial.named, 0, 'a move with a taken target changes neither name');
  assert.equal(nameOf(sql, NAME), OTHER);
  assert.equal(nameOf(sql, taken), KEPT);
  const moved = '/Recordings/SUB/moved.mp4';
  assert.equal(store.putNames([{ name: moved, identity: OTHER, expected_identity: null }, { name: NAME, remove: true, expected_identity: OTHER }]).named, 2);
  assert.equal(nameOf(sql, NAME), null);
  assert.equal(nameOf(sql, moved), OTHER);
});

test('a finished upload keeps its bytes if another writer took its expected name', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  kept(sql, KEPT);
  kept(sql, OTHER);
  store.putNames([{ name: NAME, identity: KEPT }]);
  const growing = upload(store, `up:${'7'.repeat(32)}`);
  const edited = `1f:${'e'.repeat(64)}`;
  arrive(sql, growing, edited);
  store.putNames([{ name: NAME, identity: OTHER, expected_identity: KEPT }]);
  const result = store.finishGrowing(growing, edited, 'attested', null, null, { name: NAME, expected_identity: KEPT });
  assert.equal(result.file.identity, edited);
  assert.equal(result.conflicts[0].current_identity, OTHER);
  assert.equal(nameOf(sql, NAME), OTHER);
  assert.ok(store.locate(edited), 'the losing edit is recoverable by its content identity');
  assert.equal(store.putNames([{ name: NAME, identity: edited, expected_identity: OTHER }]).named, 1, 'retry from the current version succeeds');
});

test('finishing edited bytes and moving their name checks both names before either changes', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  const old = '/Recordings/SUB/original.mp4';
  const target = '/Recordings/SUB/renamed.mp4';
  kept(sql, KEPT);
  kept(sql, OTHER);
  store.putNames([{ name: old, identity: KEPT, byte_length: 10 }, { name: target, identity: OTHER, byte_length: 10 }]);
  const growing = upload(store, `up:${'8'.repeat(32)}`);
  const edited = `1f:${'f'.repeat(64)}`;
  arrive(sql, growing, edited);
  const changes = [
    { name: target, expected_identity: null },
    { name: old, remove: true, expected_identity: KEPT },
  ];
  const refused = store.finishGrowing(growing, edited, 'attested', null, null, changes);
  assert.equal(refused.conflicts[0].name, target);
  assert.equal(nameOf(sql, old), KEPT, 'the old name remains when the target is occupied');
  assert.equal(nameOf(sql, target), OTHER);
  assert.ok(store.locate(edited), 'edited bytes remain recoverable by identity');
  store.putNames([{ name: target, remove: true, expected_identity: OTHER }]);
  assert.equal(store.putNames([{ name: target, identity: edited, expected_identity: null }, { name: old, remove: true, expected_identity: KEPT }]).named, 2);
  assert.equal(nameOf(sql, old), null);
  assert.equal(nameOf(sql, target), edited);
});

test('a duplicate name in one conditional batch never bypasses the original-row comparison', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  kept(sql, KEPT);
  kept(sql, OTHER);
  store.putNames([{ name: NAME, identity: KEPT }]);
  const result = store.putNames([
    { name: NAME, remove: true, expected_identity: KEPT },
    { name: NAME, identity: OTHER, expected_identity: KEPT },
  ]);
  assert.equal(result.named, 0);
  assert.equal(result.conflicts[0].code, 'duplicate_name');
  assert.equal(nameOf(sql, NAME), KEPT);
});

test('a name an earlier version lent to an unfinished send goes back to its kept file', () => {
  const { sql } = sqliteHost(':memory:');
  namespaceStore(sql);
  kept(sql, KEPT);
  const growing = `up:${'5'.repeat(32)}`;
  sql.exec("INSERT INTO namespace_growing (growing, byte_length, media_type, origin, started_at, aliases) VALUES (?, 10, 'video/mp4', 'test', ?, '[]')", growing, new Date().toISOString());
  sql.exec("INSERT INTO namespace_names (name, collection, identity, named_at) VALUES (?, '/Recordings/SUB', ?, ?)", NAME, growing, new Date().toISOString());
  sql.exec('CREATE TABLE namespace_names_lent (upload TEXT NOT NULL, name TEXT NOT NULL, identity TEXT NOT NULL, lent_at TEXT NOT NULL, PRIMARY KEY (upload, name))');
  sql.exec('INSERT INTO namespace_names_lent VALUES (?, ?, ?, ?)', growing, NAME, KEPT, new Date().toISOString());
  const store = namespaceStore(sql);
  assert.equal(nameOf(sql, NAME), KEPT);
  assert.equal(promises(sql), 1);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'namespace_names_lent'").toArray()[0].n, 0);
  assert.equal(store.unnamed().count, 0);
});

test('unnamed counts kept files no name points at and lists them newest first with their other identities', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  kept(sql, KEPT);
  kept(sql, OTHER);
  store.putNames([{ name: '/a.mp4', identity: OTHER }]);
  store.addAliases(KEPT, [`up:${'6'.repeat(32)}`]);
  const { count, files } = store.unnamed();
  assert.equal(count, 1);
  assert.deepEqual(files.map(file => [file.identity, file.aliases]), [[KEPT, [`up:${'6'.repeat(32)}`]]]);
});
