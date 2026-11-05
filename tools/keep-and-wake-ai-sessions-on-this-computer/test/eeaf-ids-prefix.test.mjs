// Ported from old trillion test/eeaf-ids-prefix.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The stores are this tool's (parts/eeaf, src/decision-store.mjs); countingHost is
// test/counting-host-for-tests.mjs, the old helper without its PersonStore. Every assertion is the old one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { decisionStore } from '../src/decision-store.mjs';
import { sqliteHost } from '../src/local-store.mjs';
import { setRecordEngine } from '../src/record-engine.mjs';
import { countingHost } from './counting-host-for-tests.mjs';

test('EEAF ids walks a literal prefix in the existing type and id index with unchanged page order', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const eeaf = eeafStore(sql, { transaction, hash: text => `members:${text}` });
  for (const id of ['note:one', 'note:two', 'note:three', 'note%:one', 'note_:one', 'note😀:one', 'note😁:one', `note${String.fromCodePoint(0x10ffff)}:one`]) {
    eeaf.write([{ id, type: 'note', value: { label: id } }]);
  }
  assert.deepEqual(eeaf.ids('note', { prefix: 'note:' }), ['note:one', 'note:three', 'note:two']);
  assert.deepEqual(eeaf.ids('note', { prefix: 'note:', limit: 2 }), ['note:two', 'note:three']);
  assert.deepEqual(eeaf.ids('note', { prefix: 'note:', before: 'note:two', limit: 2 }), ['note:three', 'note:one']);
  assert.deepEqual(eeaf.ids('note', { prefix: 'note%:' }), ['note%:one']);
  assert.deepEqual(eeaf.ids('note', { prefix: 'note_:' }), ['note_:one']);
  assert.deepEqual(eeaf.ids('note', { prefix: 'note😀:' }), ['note😀:one']);
  assert.deepEqual(eeaf.ids('note', { prefix: `note${String.fromCodePoint(0x10ffff)}` }), [`note${String.fromCodePoint(0x10ffff)}:one`]);
  assert.deepEqual(eeaf.ids('note', { prefix: 'note😀:missing' }), []);
});

test('settings prefix reads only matching SQLite rows on an EEAF store with thousands of other settings', () => {
  const meter = countingHost();
  setRecordEngine(meter.sql, 'eeaf');
  const store = decisionStore(meter.sql, { transaction: meter.host.transaction });
  for (const [name, value] of [['mcp-client:key:a', { name: 'Claude' }], ['mcp-client:key:b', { name: 'Codex' }], ['mcp-client:key:c', { name: 'Muse' }], ['mcp-client:other', { name: 'Other' }]]) {
    store.setSetting(name, value);
  }
  // These are valid empty setting roots. Only the three chosen settings need values; the thousands of distractors
  // exercise the real indexed entity_types table without making the fixture's setup dominate its read measurement.
  meter.host.transaction(() => {
    for (let index = 0; index < 4000; index += 1) {
      const id = `setting:other:${String(index).padStart(5, '0')}`;
      meter.host.sql.exec('INSERT INTO entity (id) VALUES (?)', id);
      meter.host.sql.exec('INSERT INTO entity_types (entity_id, type_id) VALUES (?, ?)', id, 'type:setting');
    }
  });
  const expected = store.eeaf.ids('setting').filter(id => id.startsWith('setting:mcp-client:key:')).map(id => ({ name: id.slice('setting:'.length), value: store.eeaf.read(id)?.value ?? null }));
  assert.equal(store.eeaf.ids('setting').length, 4004, 'the old call would return every setting id');
  const fresh = decisionStore(meter.sql, { transaction: meter.host.transaction });
  meter.take();
  assert.deepEqual(fresh.settings('mcp-client:key:'), expected);
  const reads = meter.take();
  const idsRead = reads.find(row => /SELECT entity_id FROM entity_types WHERE type_id = \? AND entity_id >= \?/.test(row.query));
  assert.ok(idsRead, 'the settings call uses the generic indexed prefix query');
  assert.equal(idsRead.rows, 3, 'the SQL result is bounded by matching settings');
  assert.ok(reads.reduce((sum, row) => sum + row.rows, 0) < 100, 'the entire settings read stays bounded');
  const plan = meter.host.sql.exec(`EXPLAIN QUERY PLAN ${idsRead.query}`, ...idsRead.params).toArray().map(row => row.detail).join(' ; ');
  assert.match(plan, /SEARCH entity_types USING COVERING INDEX idx_entity_types_type_entity \(type_id=\? AND entity_id>\? AND entity_id<\?\)/);
});

test('settings keeps the same prefix results on the record-log engine', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = decisionStore(sql, { transaction });
  store.setSetting('mcp-client:key:a', { name: 'Claude' });
  store.setSetting('mcp-client:key:b', { name: 'Codex' });
  store.setSetting('mcp-client:other', { name: 'Other' });
  assert.deepEqual(store.settings('mcp-client:key:'), [
    { name: 'mcp-client:key:a', value: { name: 'Claude' } },
    { name: 'mcp-client:key:b', value: { name: 'Codex' } },
  ]);
  for (const suffix of ['%', '_', '😀', '😁', '\uffff', '\u{10000}']) store.setSetting(`mcp-client:key:${suffix}`, { name: suffix });
  const prefix = 'setting:mcp-client:key:';
  const expected = store.eeaf.ids('setting').filter(id => id.startsWith(prefix));
  assert.deepEqual(store.eeaf.ids('setting', { prefix }), expected, 'the key range preserves all literal matches');
  assert.deepEqual(store.eeaf.ids('setting', { prefix, limit: 2 }), expected.slice(-2).reverse(), 'a prefix page stays newest first');
  const before = `${prefix}b`;
  assert.deepEqual(store.eeaf.ids('setting', { prefix, before, limit: 2 }),
    expected.filter(id => id < before).slice(-2).reverse(), 'a page before one matching id stays inside the prefix');
  assert.deepEqual(store.eeaf.ids('setting', { prefix, before: 'setting:mcp-client:aaa', limit: 2 }), [],
    'a before cursor outside the prefix cannot return another setting');
  assert.deepEqual(store.eeaf.ids('setting', { prefix: `${prefix}😀` }), [`${prefix}😀`]);
  assert.deepEqual(store.eeaf.ids('setting', { prefix: `${prefix}\uffff` }), [`${prefix}\uffff`]);
  assert.deepEqual(store.eeaf.ids('setting', { prefix: `${prefix}\u{10000}` }), [`${prefix}\u{10000}`]);
  store.eeaf.checkpoint();
  store.setSetting('mcp-client:key:later', { name: 'Later' });
  const reopened = decisionStore(sql, { transaction });
  assert.deepEqual(reopened.eeaf.ids('setting', { prefix }),
    reopened.eeaf.ids('setting').filter(id => id.startsWith(prefix)),
    'the same range spans stored pages and recent writes after reopening');
});

test('settingsPage walks every setting and allowance once, keeps tombstones out, and exposes the next cursor', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = decisionStore(sql, { transaction });
  for (const [name, value] of [
    ['prefs:a', { value: 'a' }], ['prefs:b', { value: 'b' }], ['prefs:c', { value: 'c' }],
    ['prefs:removed', { value: 'removed' }],
    ['allowance:decisions:month:2026-08', { used: 2 }], ['allowance:decisions:month:2026-09', { used: 7 }], ['allowance:decisions:month:2026-10', { used: 4 }],
    ['other:unrelated', { value: 'other' }],
  ]) store.setSetting(name, value);
  store.setSetting('prefs:removed', null);

  const allPages = prefix => {
    const rows = [];
    let before;
    do {
      const page = store.settingsPage(prefix, { ...(before === undefined ? {} : { before }), limit: 2 });
      rows.push(...page.settings);
      before = page.next_before;
    } while (before !== null);
    return rows;
  };
  const actual = rows => [...rows].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(actual(allPages('prefs:')), actual(store.settings('prefs:')));
  assert.equal(allPages('prefs:').some(row => row.name === 'prefs:removed'), false, 'a deleted setting is not paged');
  const allowancePages = allPages('allowance:');
  const exactMap = Object.fromEntries(allowancePages.filter(row => row.value).map(row => [row.name.split(':').at(-1), row.value.used]));
  assert.deepEqual(exactMap, Object.fromEntries(store.settings('allowance:').filter(row => row.value).map(row => [row.name.split(':').at(-1), row.value.used])));
  assert.equal(allPages('other:').length, 1, 'a page stays inside its literal prefix');
});

test('settingsPage carries cursors across missing values and clamps invalid limits', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = decisionStore(sql, { transaction });
  for (const name of ['prefs:a', 'prefs:b', 'prefs:c']) store.setSetting(name, { value: name });
  const read = store.eeaf.read;
  store.eeaf.read = id => id === 'setting:prefs:c' ? null : read(id);
  const first = store.settingsPage('prefs:', { limit: 1 });
  assert.deepEqual(first.settings, [{ name: 'prefs:c', value: null }]);
  assert.equal(first.next_before, 'prefs:c', 'a missing value still advances the raw key cursor');
  assert.equal(store.settingsPage('prefs:', { before: first.next_before, limit: 1 }).settings.length, 1);
  assert.throws(() => store.settingsPage('allowance:', { before: 'prefs:a' }), /inside its prefix/);

  const originalIds = store.eeaf.ids;
  const limits = [];
  store.eeaf.ids = (type, options) => { limits.push(options.limit); return originalIds(type, options); };
  store.settingsPage('prefs:', { limit: 0 });
  store.settingsPage('prefs:', { limit: 'not a number' });
  store.settingsPage('prefs:', { limit: 5000 });
  assert.deepEqual(limits, [2, 201, 1001], 'the requested page is always capped and the sentinel is included');
});
