// Recently Deleted and Archived (namespace-set-aside.mjs): deleting takes a file's names out of view into Recently
// Deleted with the days it has left, Put back gives them back, and the sweep removes them for good only once the
// keep-for time has ended. Archive moves on into Recently Deleted when its own time ends.
//
// Ported from the old repository's test/namespace-set-aside.test.mjs (commit 1e886c3f68, 371 lines, 16 tests), which the move to
// the Workshop left behind. Every assertion of the store's 13 tests is the old one. Left out, because what they ran is
// gone with the hosted Worker and its Workshop home has its own test: 'the file tools ... through the namespace routes'
// (the routes, tools/organize-my-files file-tools.mjs), and 'a recording deleted from Media ...' (media-library, tools/
// browse-my-recordings-and-media). 'The Recently Deleted Workshop rows pass their own samples' read the old
// records/workshop-recently-deleted-tool-records.json, whose six tools nothing wires yet (research row verify-every-port/recently-deleted-and-storage).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';
import { hiddenAmong, setAsideStore } from '../namespace-set-aside.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';


const DAY = 86400000;
const identity = digit => `1f:${String(digit).repeat(64)}`;
const START = Date.UTC(2026, 8, 1, 12);

function setUp() {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const records = decisionStore(sql, { transaction });
  let clock = START;
  let ids = 0;
  const keepFor = { read: () => records.setting('keep_for'), write: value => records.setSetting('keep_for', value) };
  const aside = setAsideStore(sql, { keepFor, now: () => clock, newId: () => `item-${++ids}` });
  names.putNames([
    { name: '/Trips/beach.mp4', identity: identity(1), byte_length: 100, modified_at_ms: START - DAY },
    { name: '/Trips/Day 2/boat.mp4', identity: identity(2), byte_length: 200, modified_at_ms: START - DAY },
    { name: '/notes.txt', identity: identity(3), byte_length: 5, modified_at_ms: START - DAY },
  ]);
  return { sql, names, aside, later: days => { clock += days * DAY; }, now: () => clock };
}
const listed = (names, folder) => names.listNames(folder, '', 100).names.map(row => row.name);

test('deleting a file lists it in Recently Deleted with the days it has left, and takes its name out of Files', () => {
  const { names, aside, later } = setUp();
  const done = aside.setAside({ items: [{ name: '/notes.txt' }], state: 'deleted', by: 'person' });
  assert.deepEqual(done.refused, []);
  assert.equal(done.said, 'Moved to Recently Deleted');
  assert.deepEqual(listed(names, '/'), [], 'the name is gone from its folder');
  assert.equal(names.entry('/notes.txt'), null);

  const [row] = aside.list().items;
  assert.equal(row.label, 'notes.txt');
  assert.equal(row.state_label, 'Recently Deleted');
  assert.deepEqual(row.names, ['/notes.txt']);
  assert.equal(row.where, '/');
  assert.equal(row.days_left, 30);
  assert.equal(row.due_words, 'Deleted for good');
  later(10);
  assert.equal(aside.list().items[0].days_left, 20, 'the days left are worked out when read');
});

test('a stale File Provider delete leaves the newer version visible', () => {
  const { names, aside } = setUp();
  names.putNames([{ name: '/notes.txt', identity: identity(9), expected_identity: identity(3), byte_length: 9 }]);
  const stale = aside.setAside({ items: [{ name: '/notes.txt', expected_identity: identity(3) }], state: 'deleted' });
  assert.equal(stale.set_aside.length, 0);
  assert.equal(stale.refused[0].code, 'stale_version');
  assert.equal(stale.refused[0].current_identity, identity(9));
  assert.equal(names.entry('/notes.txt').identity, identity(9));
  assert.equal(aside.list().items.length, 0);
  const current = aside.setAside({ items: [{ name: '/notes.txt', expected_identity: identity(9) }], state: 'deleted' });
  assert.equal(current.set_aside.length, 1);
});

test('a promised replacement blocks deletion of its file, folder and old content identity', () => {
  const { names, aside } = setUp();
  names.keepWholeFiles([{ identity: identity(1), byte_length: 100, origin: 'test', key: 'beach', name: '/Trips/beach.mp4' }]);
  const upload = `up:${'a'.repeat(32)}`;
  names.startGrowing({ growing: upload, byte_length: 110, media_type: 'video/mp4', origin: 'test' }, { name: '/Trips/beach.mp4' });
  assert.equal(names.entry('/Trips/beach.mp4').identity, identity(1), 'the old file stays visible until replacement finishes');
  const revision = names.entry('/Trips').revision;
  for (const asked of [
    { name: '/Trips/beach.mp4', expected_identity: identity(1) },
    { name: '/Trips', expected_folder_revision: revision },
    { identity: identity(1) },
  ]) {
    const result = aside.setAside({ items: [asked], state: 'deleted' });
    assert.equal(result.set_aside.length, 0, JSON.stringify(asked));
    assert.match(result.refused[0].error, /still uploading/, JSON.stringify(asked));
    assert.equal(names.entry('/Trips/beach.mp4').identity, identity(1));
  }
  names.cancelGrowing(upload);
  const removed = aside.setAside({ items: [{ name: '/Trips', expected_folder_revision: names.entry('/Trips').revision }], state: 'deleted' });
  assert.equal(removed.set_aside[0].name_count, 2);
  assert.equal(names.entry('/Trips'), null);
});

test('put back gives every name back, including a whole folder', () => {
  const { names, aside } = setUp();
  const [folder] = aside.setAside({ items: [{ name: '/Trips' }], state: 'deleted' }).set_aside;
  assert.equal(folder.folder, true);
  assert.equal(folder.name_count, 2);
  assert.equal(folder.byte_length, 300);
  assert.deepEqual(names.childFolders('/'), []);

  const back = aside.putBack([folder.id]);
  assert.deepEqual(back.results, [{ id: folder.id, label: 'Trips', put_back: true }]);
  assert.deepEqual(listed(names, '/Trips'), ['/Trips/beach.mp4']);
  assert.deepEqual(listed(names, '/Trips/Day 2'), ['/Trips/Day 2/boat.mp4']);
  assert.equal(names.entry('/Trips/Day 2/boat.mp4').byte_length, 200, 'its identity and size come back with it');
  assert.deepEqual(aside.list().items, [], 'nothing is left in Recently Deleted');
});

test('put back never takes a name another file was given in the meantime', () => {
  const { names, aside } = setUp();
  const [row] = aside.setAside({ items: [{ name: '/notes.txt' }], state: 'deleted' }).set_aside;
  names.putNames([{ name: '/notes.txt', identity: identity(9), byte_length: 9 }]);
  const [answer] = aside.putBack([row.id]).results;
  assert.match(answer.error, /Another file now has the name \/notes\.txt/);
  assert.equal(names.entry('/notes.txt').identity, identity(9));
  assert.equal(aside.list().items.length, 1, 'it stays in Recently Deleted to put back later');
});

test('the sweep removes a deleted file for good only after its keep-for time', () => {
  const { aside, later, now } = setUp();
  aside.setAside({ items: [{ name: '/notes.txt' }], state: 'deleted' });
  assert.equal(aside.nextDue(), START + 30 * DAY);

  later(29);
  assert.deepEqual(aside.sweep(now()), { moved: [], removed: [] }, 'before the time ends nothing moves');
  assert.equal(aside.list().items.length, 1);

  later(1);
  const swept = aside.sweep(now());
  assert.deepEqual(swept.removed.map(row => row.label), ['notes.txt']);
  assert.deepEqual(aside.list().items, []);
  assert.equal(aside.nextDue(), null);
});

test('a shorter keep-for relabels every row at once and the sweep follows it; null keeps until put back', () => {
  const { aside, later, now } = setUp();
  aside.setAside({ items: [{ name: '/notes.txt' }], state: 'deleted' });
  later(3);
  const kept = aside.setKeepFor({ after_days: { deleted: 2 } });
  assert.equal(kept.states.find(state => state.id === 'deleted').after_days, 2);
  assert.equal(aside.list().items[0].days_left, 0);
  aside.setKeepFor({ after_days: { deleted: null } });
  assert.equal(aside.list().items[0].days_left, null);
  assert.equal(aside.nextDue(), null);
  assert.deepEqual(aside.sweep(now()).removed, []);
  aside.setKeepFor({ after_days: { deleted: 2 } });
  assert.equal(aside.sweep(now()).removed.length, 1);
  assert.throws(() => aside.setKeepFor({ after_days: { deleted: -1 } }), /whole number of days/);
  assert.throws(() => aside.setKeepFor({ after_days: { somewhere: 3 } }), /Choose one of/);
});

test('an archived file moves to Recently Deleted when its time ends, then counts again from there', () => {
  const { aside, later, now } = setUp();
  aside.setAside({ items: [{ name: '/notes.txt' }], state: 'archived' });
  assert.equal(aside.list().items[0].due_words, 'Moves to Recently Deleted');
  later(30);
  const swept = aside.sweep(now());
  assert.deepEqual(swept.moved.map(row => row.to), ['deleted']);
  const [row] = aside.list().items;
  assert.equal(row.state, 'deleted');
  assert.equal(row.by, 'schedule');
  assert.equal(row.days_left, 30);
});

test('deleting a recording by its identity hides it everywhere until put back, and a still-uploading file is refused', () => {
  const { sql, names, aside } = setUp();
  names.putNames([{ name: '/Trips/beach copy.mp4', identity: identity(1), byte_length: 100 }]);
  const [row] = aside.setAside({ items: [{ identity: identity(1), label: 'Beach day' }], state: 'deleted' }).set_aside;
  assert.equal(row.label, 'Beach day');
  assert.equal(row.name_count, 2, 'every name of the file goes');
  assert.deepEqual([...hiddenAmong(sql, [identity(1), identity(2)])], [identity(1)]);
  aside.putBack([row.id]);
  assert.deepEqual([...hiddenAmong(sql, [identity(1)])], []);

  // One name of two deleted in Files: the file still has a name, so it is not hidden.
  aside.setAside({ items: [{ name: '/Trips/beach copy.mp4' }], state: 'deleted' });
  assert.deepEqual([...hiddenAmong(sql, [identity(1)])], []);
  // Its last name deleted too: hidden, also when asked by another identity of the same file (a drive's address).
  names.addAliases(identity(1), [`12:${'c'.repeat(64)}`]);
  aside.setAside({ items: [{ name: '/Trips/beach.mp4' }], state: 'deleted' });
  assert.deepEqual([...hiddenAmong(sql, [identity(1), `12:${'c'.repeat(64)}`])], [identity(1), `12:${'c'.repeat(64)}`]);

  names.putNames([{ name: '/growing.mov', identity: `up:${'a'.repeat(32)}` }]);
  const refused = aside.setAside({ items: [{ name: '/growing.mov' }, { name: '/nothing-here' }, { name: '/' }], state: 'deleted' }).refused;
  assert.deepEqual(refused.map(item => item.error), ['It is still uploading. Wait for it to finish, or stop the upload.', 'No file or folder has this name.', 'Your whole Files cannot be deleted. Choose files or folders inside it.']);
});

test('the list pages newest first', () => {
  const { aside, later } = setUp();
  aside.setAside({ items: [{ name: '/notes.txt' }], state: 'deleted' });
  later(1);
  aside.setAside({ items: [{ name: '/Trips/beach.mp4' }], state: 'archived' });
  const first = aside.list({ limit: 1 });
  assert.deepEqual(first.items.map(row => row.label), ['beach.mp4']);
  const second = aside.list({ limit: 1, after: first.next_after });
  assert.deepEqual(second.items.map(row => row.label), ['notes.txt']);
  assert.equal(second.next_after, null);
  assert.deepEqual(aside.list({ state: 'archived' }).items.map(row => row.label), ['beach.mp4']);
});

// The tools any AI calls (src/file-tools.mjs) through the same namespace routes a key or the Files page reaches.

test('checking a large library for set-aside files reads each table once, not once per file', () => {
  // A person with 20,000 named files, each also known by a drive alias, asks about all 40,000 identities while 200
  // files are set aside (100 still named elsewhere, 100 not). The check answered per identity with no usable index and
  // took minutes of the store's single-threaded time at this size, so every other screen waited behind Media.
  const { sql } = sqliteHost(':memory:');
  namespaceStore(sql);
  const own = index => `1f:${index.toString(16).padStart(64, '0')}`;
  const drive = index => `12:${index.toString(16).padStart(64, '0')}`;
  sql.exec('BEGIN');
  for (let index = 0; index < 20000; index += 1) {
    sql.exec('INSERT INTO namespace_aliases (alias, identity, grade, added_at) VALUES (?, ?, ?, ?)', drive(index), own(index), 'same-bytes', 'now');
    if (index >= 100) sql.exec('INSERT INTO namespace_names (name, collection, identity, byte_length, modified_at_ms, named_at) VALUES (?, ?, ?, 1, 1, ?)', `/Clips/${index}.mp4`, '/Clips', own(index), 'now');
  }
  for (let index = 0; index < 200; index += 1) {
    sql.exec('INSERT INTO namespace_set_aside (id, label, state, set_aside_ms) VALUES (?, ?, ?, ?)', `item-${index}`, 'clip', 'deleted', index);
    sql.exec('INSERT INTO namespace_set_aside_names (id, ordinal, name, collection, identity) VALUES (?, 0, ?, ?, ?)', `item-${index}`, `/Old/${index}.mp4`, '/Old', drive(index));
  }
  sql.exec('COMMIT');
  const asked = Array.from({ length: 20000 }, (_, index) => [own(index), drive(index)]).flat();
  const started = performance.now();
  const hidden = hiddenAmong(sql, asked);
  const took = performance.now() - started;
  // Set aside and named nowhere: indexes 0 to 99, under both of their identities. 100 to 199 still have a name.
  assert.deepEqual([...hidden].sort(), Array.from({ length: 100 }, (_, index) => [own(index), drive(index)]).flat().sort());
  assert.ok(took < 2000, `the check took ${Math.round(took)} ms for 40,000 identities`);
});

test('one requested alias seeks set-aside identities even behind 50,000 unrelated archived names', () => {
  const { sql } = sqliteHost(':memory:');
  namespaceStore(sql);
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 50000)
    INSERT INTO namespace_set_aside_names (id, ordinal, identity)
    SELECT printf('archived-%08d', n), 0, printf('unrelated-%08d', n) FROM sequence`);
  const file = `1f:${'a'.repeat(64)}`;
  const archivedAlias = `12:${'b'.repeat(64)}`;
  const requestedAlias = `12:${'c'.repeat(64)}`;
  for (const alias of [archivedAlias, requestedAlias]) {
    sql.exec("INSERT INTO namespace_aliases (alias, identity, grade, added_at) VALUES (?, ?, 'same-bytes', 'now')", alias, file);
  }
  sql.exec('INSERT INTO namespace_set_aside_names (id, ordinal, identity) VALUES (?, 0, ?)', 'requested-archive', archivedAlias);

  const base = sql.exec;
  const setAsideQueries = [];
  sql.exec = (query, ...values) => {
    if (query.includes('FROM namespace_set_aside_names')) setAsideQueries.push({ query, values });
    return base(query, ...values);
  };
  assert.deepEqual([...hiddenAmong(sql, [requestedAlias])], [requestedAlias], 'a sibling drive alias is hidden too');
  assert.equal(setAsideQueries[0].values[0], 2, 'the archive peek is bounded by the requested identity count');
  const sought = setAsideQueries.find(({ query }) => query.includes('WHERE identity IN (SELECT value FROM json_each(?))'));
  assert.ok(sought, 'the large-archive path seeks only the requested alias family');
  const plan = base(`EXPLAIN QUERY PLAN ${sought.query}`, ...sought.values).toArray().map(row => row.detail).join(' ; ');
  assert.match(plan, /SEARCH namespace_set_aside_names USING COVERING INDEX namespace_set_aside_names_identity \(identity=\?\)/, plan);
  assert.doesNotMatch(plan, /SCAN namespace_set_aside_names/, plan);

  sql.exec('INSERT INTO namespace_names (name, collection, identity, named_at) VALUES (?, ?, ?, ?)', '/Videos/kept.mp4', '/Videos', file, 'now');
  assert.deepEqual([...hiddenAmong(sql, [requestedAlias])], [], 'an active name under the canonical identity keeps the file visible');
  sql.exec('DELETE FROM namespace_names WHERE name = ?', '/Videos/kept.mp4');
  assert.deepEqual([...hiddenAmong(sql, [file, requestedAlias])], [file, requestedAlias], 'canonical and sibling aliases share one hidden state');
});

test('a many-named archived file cannot turn the bounded peek into a distinct-name scan', () => {
  const { sql } = sqliteHost(':memory:');
  namespaceStore(sql);
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 50000)
    INSERT INTO namespace_set_aside_names (id, ordinal, identity)
    SELECT printf('archived-%08d', n), 0, 'one-file' FROM sequence`);
  const base = sql.exec;
  let peek = null;
  sql.exec = (query, ...values) => {
    if (query.includes('FROM namespace_set_aside_names') && query.includes('LIMIT ?')) peek = { query, values };
    return base(query, ...values);
  };
  assert.deepEqual([...hiddenAmong(sql, ['another-file'])], []);
  assert.ok(peek, 'the archive is sampled before choosing the indexed requested side');
  assert.equal(peek.values[0], 2);
  assert.doesNotMatch(peek.query, /DISTINCT/, 'DISTINCT would traverse every archived name sharing one identity');
  const plan = base(`EXPLAIN QUERY PLAN ${peek.query}`, ...peek.values).toArray().map(row => row.detail).join(' ; ');
  assert.match(plan, /namespace_set_aside_names_identity/, plan);
});
