import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { NativeWorkspaceRecords } from '../src/native-workspace-records.mjs';
import historyRules from '../../make-screen-layouts-and-controls/src/workspace-record-history.json' with { type: 'json' };
import { setupWorkspaceRecordTables, workspaceValueIdentity } from '../../set-up-my-account/read-data/conflicts.mjs';

const address = 'package::documents::documents::book-a';
const initial = () => ({ title: 'Notebook', children: [
  { id: 'page-a', title: 'Page A', text: 'first draft' },
  { id: 'page-b', title: 'Page B', text: 'sibling stays' },
] });

function ownerFor(t) {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const live = { changedFor: (_paths, change) => change() };
  return { host, owner: new NativeWorkspaceRecords({ sql: host.sql, transaction: host.transaction, live }) };
}

test('workspace revision capture is member-scoped, no-op safe, paged, and retains legacy provenance truthfully', t => {
  const { host, owner } = ownerFor(t);
  setupWorkspaceRecordTables(host.sql);
  const legacy = initial();
  host.sql.exec('INSERT INTO workspace_records(label,value,written_at) VALUES(?,?,?)', address, JSON.stringify(legacy), '2026-10-01T12:00:00.000Z');

  const edited = { ...legacy, children: legacy.children.map(page => page.id === 'page-a' ? { ...page, text: 'second draft' } : page) };
  owner.putWorkspaceRecords([{ address_label: address, payload: edited, expected_identity: workspaceValueIdentity(legacy) }], { author: 'writer-current' });
  const newest = owner.workspaceRevisionHistory(address, { scope_id: 'page-a', limit: 1 });
  assert.equal(newest.revisions.length, 1);
  assert.equal(newest.revisions[0].number, 2);
  assert.equal(newest.revisions[0].by, 'writer-current');
  assert.equal(newest.revisions[0].current, true);
  assert.ok(newest.next_cursor);
  const older = owner.workspaceRevisionHistory(address, { scope_id: 'page-a', before: newest.next_cursor });
  assert.equal(older.revisions.length, 1);
  assert.equal(older.revisions[0].number, 1);
  assert.equal(older.revisions[0].at, '2026-10-01T12:00:00.000Z');
  assert.equal(older.revisions[0].by, null);
  assert.equal(older.revisions[0].current, false);

  const sibling = owner.workspaceRevisionHistory(address, { scope_id: 'page-b' });
  assert.equal(sibling.revisions.length, 0, 'unchanged legacy pages do not acquire invented historical revisions');
  owner.putWorkspaceRecords([{ address_label: address, payload: edited, expected_identity: workspaceValueIdentity(edited) }], { author: 'retry' });
  assert.equal(owner.workspaceRevisionHistory(address, { scope_id: 'page-a' }).revisions.length, 2);
});

test('restore compares the reviewed member identity and preserves current siblings', t => {
  const { owner } = ownerFor(t);
  const before = initial();
  owner.putWorkspaceRecords([{ address_label: address, payload: before, expected_identity: null }], { author: 'initial' });
  const firstRevision = owner.workspaceRevisionHistory(address, { scope_id: 'page-a' }).revisions[0];
  const firstRevisionValue = owner.workspaceRevision(firstRevision.id);
  const current = owner.workspaceRecord(address);
  const changed = { ...current, children: current.children.map(page => page.id === 'page-a' ? { ...page, text: 'newer text' } : page) };
  owner.putWorkspaceRecords([{ address_label: address, payload: changed, expected_identity: workspaceValueIdentity(current) }], { author: 'editor' });
  const stale = owner.restoreWorkspaceRevision(address, firstRevision.id, workspaceValueIdentity(firstRevisionValue.value), 'restorer', 'page-a');
  assert.equal(stale.restored, false);
  assert.equal(stale.conflict, true);

  const editedSibling = { ...changed, children: changed.children.map(page => page.id === 'page-b' ? { ...page, text: 'sibling updated after review' } : page) };
  owner.putWorkspaceRecords([{ address_label: address, payload: editedSibling, expected_identity: workspaceValueIdentity(changed) }], { author: 'sibling-editor' });
  const currentPageIdentity = owner.workspaceRevisionHistory(address, { scope_id: 'page-a' }).current_identity;
  const asked = { address, id: firstRevision.id, expected_identity: currentPageIdentity, scope_id: 'page-a' };
  assert.deepEqual(owner.restoreOutcome(asked), { state: 'aborted' }, 'a restore whose call is gone before its write restored nothing');
  const restored = owner.restoreWorkspaceRevision(address, firstRevision.id, currentPageIdentity, 'restorer', 'page-a');
  assert.equal(restored.restored, true);
  assert.deepEqual(owner.restoreOutcome(asked), { state: 'committed', result: restored }, 'the member now the restored version is that restore, with its reply');
  const final = owner.workspaceRecord(address);
  assert.equal(final.children.find(page => page.id === 'page-a').text, 'first draft');
  assert.equal(final.children.find(page => page.id === 'page-b').text, 'sibling updated after review');
});

test('scoped erasure is idempotent and rejects replay of erased words; a reconstructed owner reads persisted revisions', t => {
  const { host, owner } = ownerFor(t);
  const value = initial();
  owner.putWorkspaceRecords([{ address_label: address, payload: value, expected_identity: null }], { author: 'initial' });
  const selected = value.children[0];
  const erased = owner.eraseDocument(address, workspaceValueIdentity(selected), 'page-a');
  assert.equal(erased.erased, true);
  assert.equal(owner.documentErasure(address, 'page-a').done, true);
  assert.equal(owner.eraseDocument(address, workspaceValueIdentity(selected), 'page-a').replayed, true);
  assert.throws(() => owner.putWorkspaceRecords([{ address_label: address, payload: value }]), /erased document version/);

  const replacementOwner = new NativeWorkspaceRecords({ sql: host.sql, transaction: host.transaction, live: { changedFor: (_paths, change) => change() } });
  assert.equal(replacementOwner.workspaceRevisionHistory(address, { scope_id: 'page-b' }).revisions.length, 1);
  assert.deepEqual(replacementOwner.workspaceRecord(address).children.map(page => page.id), ['page-b']);
});

test('shared-room and other record history refuses with an owner-specific capability result', t => {
  const { owner } = ownerFor(t);
  assert.throws(() => owner.workspaceRevisionHistory('shared-room:space-a', { scope_id: 'page-a' }), /shared-room history is not supported/);
});


test('erased page identities reject changed stale content and whole-scene recreation', t => {
  const { owner } = ownerFor(t);
  const value = initial();
  owner.putWorkspaceRecords([{ address_label: address, payload: value, expected_identity: null }]);
  owner.eraseDocument(address, workspaceValueIdentity(value.children[0]), 'page-a');
  const changed = structuredClone(value);
  changed.children[0].style = { color: 'blue' };
  assert.throws(() => owner.putWorkspaceRecords([{ address_label: address, payload: changed }]), /erased document version/);
  assert.equal(owner.documentErasure(address, 'page-a').done, true);
  assert.equal(owner.workspaceConflicts().conflicts.length, 0);
  const current = owner.workspaceRecord(address);
  owner.eraseDocument(address, workspaceValueIdentity(current));
  assert.throws(() => owner.putWorkspaceRecords([{ address_label: address, payload: changed, expected_identity: null }]), /erased document version/);
});


test('bounded indexed history reclamation keeps counters within DATA limits without rejecting edits', t => {
  const { host, owner } = ownerFor(t);
  const prior = historyRules.max_total_revisions;
  historyRules.max_total_revisions = 3;
  t.after(() => { historyRules.max_total_revisions = prior; });
  let current = null;
  for (let i = 0; i < 9; i += 1) {
    const next = { children: [{ id: 'retained-page', text: 'Draft ' + i }] };
    assert.equal(owner.putWorkspaceRecords([{ address_label: address, payload: next, expected_identity: current ? workspaceValueIdentity(current) : null }]).written, 1);
    current = next;
  }
  const budget = host.sql.exec('SELECT total_bytes,total_count FROM workspace_document_revision_budget WHERE id=1').toArray()[0];
  assert.equal(Number(budget.total_count), 3);
  const actual = host.sql.exec('SELECT COUNT(*) AS count,SUM(length(CAST(value AS BLOB))) AS bytes FROM workspace_document_revisions').toArray()[0];
  assert.equal(Number(actual.count), Number(budget.total_count));
  assert.equal(Number(actual.bytes), Number(budget.total_bytes));
  assert.equal(owner.workspaceRecord(address).children[0].text, 'Draft 8');
});


test('document configuration and index rows retain their ordinary workspace write behavior', t => {
  const { owner } = ownerFor(t);
  for (const label of ['package::documents::runtime-config', 'package::documents::document-index::book-a']) {
    const value = { title: 'Index metadata', enabled: true };
    assert.equal(owner.putWorkspaceRecords([{ address_label: label, payload: value, expected_identity: null }]).written, 1);
    assert.deepEqual(owner.workspaceRecord(label), value);
    assert.equal(owner.keepsRevisionHistory(label), false);
  }
});

test('a warm workspace call runs no schema statement, and a store holding only its older table realizes the rest on first need', t => {
  const { host, owner } = ownerFor(t);
  host.sql.exec('CREATE TABLE workspace_records (label TEXT PRIMARY KEY, value TEXT NOT NULL, written_at TEXT NOT NULL)');
  const legacy = initial();
  host.sql.exec('INSERT INTO workspace_records(label,value,written_at) VALUES(?,?,?)', address, JSON.stringify(legacy), '2026-10-01T12:00:00.000Z');
  const edited = { ...legacy, children: legacy.children.map(page => page.id === 'page-a' ? { ...page, text: 'second draft' } : page) };
  owner.putWorkspaceRecords([{ address_label: address, payload: edited, expected_identity: workspaceValueIdentity(legacy) }], { author: 'writer-current' });
  assert.equal(owner.workspaceRevisionHistory(address, { scope_id: 'page-a', limit: 1 }).revisions.length, 1);
  const statements = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...bindings) => { statements.push(query); return exec(query, ...bindings); };
  owner.workspaceRecords([address]);
  host.sql.exec = exec;
  assert.deepEqual(statements.filter(query => /^\s*(CREATE|INSERT OR IGNORE)\b/i.test(query)), []);
});
