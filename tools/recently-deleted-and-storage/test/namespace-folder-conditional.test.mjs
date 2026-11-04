import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';
import { setAsideStore } from '../namespace-set-aside.mjs';

const ID = digit => `1f:${digit.repeat(64)}`;
const namesAt = (names, folder) => names.listNames(folder, '', 1000).names.map(row => row.name);

test('moving supplementary Unicode parent paths retains every descendant separator, suffix and collection', () => {
  for (const from of ['/Plain', '/é', '/😀', '/😀😀']) {
    const { sql, transaction } = sqliteHost(':memory:');
    const names = namespaceStore(sql);
    const suffixes = ['/x.txt', '/nested/😀.mov'];
    names.putNames(suffixes.map((suffix, index) => ({ name: from + suffix, identity: ID(index ? 'b' : 'a') })));
    const moved = transaction(() => names.moveFolder(from, '/Dest😀', names.entry(from).revision));
    assert.equal(moved.moved, 2);
    for (const [index, suffix] of suffixes.entries()) {
      assert.equal(names.entry('/Dest😀' + suffix).identity, ID(index ? 'b' : 'a'));
      assert.equal(names.entry(from + suffix), null);
    }
    assert.deepEqual(namesAt(names, '/Dest😀/nested'), ['/Dest😀/nested/😀.mov']);
  }
});

test('a move refuses UTF-16-overlength results without changing any descendant', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const long = '/😀/' + '😀'.repeat(2046);
  assert.equal(long.length, 4096);
  names.putNames([{ name: long, identity: ID('a') }, { name: '/😀/short', identity: ID('b') }]);
  const moved = transaction(() => names.moveFolder('/😀', '/Longer', names.entry('/😀').revision));
  assert.match(moved.error, /too long/);
  assert.equal(names.entry(long).identity, ID('a'));
  assert.equal(names.entry('/😀/short').identity, ID('b'));
  assert.equal(names.entry('/Longer'), null);
});

test('a nested edit changes the folder version; stale move and delete leave its names intact', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const aside = setAsideStore(sql, { keepFor: { read: () => null, write: () => {} } });
  names.putNames([{ name: '/Work/deep/one.txt', identity: ID('a') }]);
  const base = names.entry('/Work').revision;
  assert.match(base, /^folder:\d+$/);
  names.putNames([{ name: '/Work/deep/two.txt', identity: ID('b') }]);
  const current = names.entry('/Work').revision;
  assert.notEqual(current, base);
  assert.equal(names.moveFolder('/Work', '/Moved', base).code, 'stale_version');
  const staleDelete = transaction(() => aside.setAside({ items: [{ name: '/Work', expected_folder_revision: base }], state: 'deleted' }));
  assert.equal(staleDelete.refused[0].code, 'stale_version');
  assert.deepEqual(namesAt(names, '/Work/deep'), ['/Work/deep/one.txt', '/Work/deep/two.txt']);
  assert.deepEqual(aside.list().items, []);
  const deleted = transaction(() => aside.setAside({ items: [{ name: '/Work', expected_folder_revision: current }], state: 'deleted' }));
  assert.equal(deleted.set_aside[0].name_count, 2);
  assert.equal(names.entry('/Work'), null);
});

test('a folder move changes more than 5,000 names in one transaction, including Unicode descendants', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  names.putNames([
    ...Array.from({ length: 5001 }, (_, i) => ({ name: `/Large/group/file-${String(i).padStart(5, '0')}.txt`, identity: ID('a') })),
    { name: '/Large/😀/clip.mov', identity: ID('b') },
    { name: '/Large-/sibling.txt', identity: ID('c') },
  ]);
  const base = names.entry('/Large').revision;
  const moved = transaction(() => names.moveFolder('/Large', '/Placed', base));
  assert.equal(moved.moved, 5002);
  assert.equal(names.entry('/Large'), null);
  assert.equal(names.entry('/Placed/😀/clip.mov').identity, ID('b'));
  assert.equal(names.entry('/Large-/sibling.txt').identity, ID('c'));
  assert.equal(namesAt(names, '/Placed/group').length, 1000);
  assert.equal(sql.exec("SELECT count(*) AS count FROM namespace_names WHERE name >= '/Placed/' AND name < '/Placed0'").toArray()[0].count, 5002);
  assert.equal(sql.exec("SELECT count(*) AS count FROM namespace_names WHERE name >= '/Large/' AND name < '/Large0'").toArray()[0].count, 0);
  assert.match(moved.revision, /^folder:\d+$/);
});

test('target collision and uploading descendants refuse a whole folder move', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  names.putNames([
    { name: '/From/a.txt', identity: ID('a') },
    { name: '/To/child.txt', identity: ID('b') },
  ]);
  const base = names.entry('/From').revision;
  assert.equal(names.moveFolder('/From', '/To', base).code, 'filename_collision');
  assert.equal(names.entry('/From/a.txt').identity, ID('a'));
  names.putNames([{ name: '/To/child.txt', remove: true }, { name: '/From/upload.bin', identity: `up:${'c'.repeat(32)}` }]);
  const uploadVersion = names.entry('/From').revision;
  assert.match(names.moveFolder('/From', '/To', uploadVersion).error, /still uploading/);
  assert.equal(names.entry('/From/a.txt').identity, ID('a'));
});

test('a replacement upload promised the current name blocks its folder move without hiding the old file', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const old = ID('d');
  names.keepWholeFiles([{ identity: old, byte_length: 10, origin: 'test', key: 'old-file', name: '/From/current.mov' }]);
  const upload = `up:${'e'.repeat(32)}`;
  const started = transaction(() => names.startGrowing({ growing: upload, byte_length: 10, media_type: 'video/quicktime', origin: 'test' }, { name: '/From/current.mov' }));
  assert.equal(started.file.identity, upload);
  assert.equal(names.entry('/From/current.mov').identity, old, 'the kept name stays visible while replacement bytes arrive');
  const revision = names.entry('/From').revision;
  assert.match(names.moveFolder('/From', '/Moved', revision).error, /still uploading/);
  assert.equal(names.entry('/From/current.mov').identity, old);
  names.cancelGrowing(upload);
  assert.equal(names.moveFolder('/From', '/Moved', names.entry('/From').revision).moved, 1);
  assert.equal(names.entry('/Moved/current.mov').identity, old);
});

test('an unnamed checked upload keeps its parent in place without showing unfinished bytes', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const aside = setAsideStore(sql, { keepFor: { read: () => null, write: () => {} } });
  names.putNames([{ name: '/From/seed.txt', identity: ID('a') }]);
  const original = names.entry('/From').revision;
  const upload = `up:${'b'.repeat(32)}`;
  transaction(() => names.startGrowing({ growing: upload, byte_length: 6, media_type: null, origin: 'test' }, null, ['/From/new.txt']));
  names.putNames([{ name: '/From2/seed.txt', identity: ID('e') }]);
  assert.equal(names.moveFolder('/From2', '/SiblingMoved', names.entry('/From2').revision).moved, 1,
    'the intent only guards its own folder prefix');
  assert.deepEqual(namesAt(names, '/From'), ['/From/seed.txt'], 'unfinished conditional bytes have no visible name');
  assert.match(names.moveFolder('/From', '/Moved', original).error, /still uploading/);
  const deletion = transaction(() => aside.setAside({ items: [{ name: '/From', expected_folder_revision: original }], state: 'deleted' }));
  assert.match(deletion.refused[0].error, /still uploading/);
  assert.equal(names.entry('/From/seed.txt').identity, ID('a'));
  names.cancelGrowing(upload);
  assert.equal(names.moveFolder('/From', '/Moved', names.entry('/From').revision).moved, 1);
  assert.equal(names.entry('/From'), null);
});

test('a checked edit blocks deletion of its current file and identity until the intent ends', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const aside = setAsideStore(sql, { keepFor: { read: () => null, write: () => {} } });
  names.putNames([{ name: '/From/current.mov', identity: ID('c') }]);
  const upload = `up:${'d'.repeat(32)}`;
  transaction(() => names.startGrowing({ growing: upload, byte_length: 6, media_type: null, origin: 'test' }, null, ['/From/current.mov']));
  assert.equal(names.entry('/From/current.mov').identity, ID('c'), 'the old file stays visible until checked finish');
  const byName = transaction(() => aside.setAside({ items: [{ name: '/From/current.mov', expected_identity: ID('c') }], state: 'deleted' }));
  assert.match(byName.refused[0].error, /still uploading/);
  const byIdentity = transaction(() => aside.setAside({ items: [{ identity: ID('c') }], state: 'deleted' }));
  assert.match(byIdentity.refused[0].error, /still uploading/);
  names.cancelGrowing(upload);
  const deleted = transaction(() => aside.setAside({ items: [{ name: '/From/current.mov', expected_identity: ID('c') }], state: 'deleted' }));
  assert.equal(deleted.set_aside.length, 1);
});

test('a name change writes one folder row; versions of every folder above it still change', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  names.putNames([{ name: '/A/B/C/D/one.mov', identity: ID('a') }, { name: '/Other/x.txt', identity: ID('b') }]);
  const rows = () => new Map(sql.exec('SELECT collection, seq FROM namespace_folder_changes').toArray().map(row => [row.collection, row.seq]));
  const before = rows();
  const versions = ['/', '/A', '/A/B', '/A/B/C', '/A/B/C/D', '/Other'].map(folder => names.entry(folder).revision);
  names.putNames([{ name: '/A/B/C/D/one.mov', identity: ID('c') }]);
  const after = rows();
  assert.deepEqual([...after].filter(([folder, seq]) => before.get(folder) !== seq).map(([folder]) => folder), ['/A/B/C/D'],
    'only the changed name\'s own folder row is written');
  const now = ['/', '/A', '/A/B', '/A/B/C', '/A/B/C/D', '/Other'].map(folder => names.entry(folder).revision);
  assert.deepEqual(now.map((version, i) => version !== versions[i]), [true, true, true, true, true, false]);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('namespace_folder_revisions', 'namespace_change_count')").toArray()[0].n, 0);
});

test('a store kept by the earlier counter keeps its change position, so no device lists everything again', () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE TABLE namespace_change_count (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)');
  sql.exec('INSERT INTO namespace_change_count (id, seq) VALUES (1, 40)');
  sql.exec('CREATE TABLE namespace_folder_changes (collection TEXT PRIMARY KEY, seq INTEGER NOT NULL)');
  sql.exec("INSERT INTO namespace_folder_changes (collection, seq) VALUES ('/Old', 12), ('/Newest', 37)");
  sql.exec('CREATE TABLE namespace_folder_revisions (folder TEXT PRIMARY KEY, revision TEXT NOT NULL)');
  const names = namespaceStore(sql);
  assert.deepEqual(names.changedFolders(40), { seq: 40, all: false, folders: [] });
  names.putNames([{ name: '/Old/new.txt', identity: ID('d') }]);
  assert.deepEqual(names.changedFolders(40), { seq: 41, all: false, folders: ['/Old'] });
});
