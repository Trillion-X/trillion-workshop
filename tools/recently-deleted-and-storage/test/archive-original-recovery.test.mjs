// The immutable carried algorithm against its original SQL contract, with synthetic data.
// This is an origin baseline, not proof of the current account-files owner or its door.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namespaceStore } from '../namespace-store.mjs';
import { setAsideStore } from '../namespace-set-aside.mjs';

function originalAt(path, now) {
  const db = new DatabaseSync(path);
  const sql = { exec(query, ...values) {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...values).map(row => ({ ...row })) : (statement.run(...values), []);
    return Object.assign(rows, { toArray: () => rows });
  } };
  const names = namespaceStore(sql);
  db.exec('CREATE TABLE IF NOT EXISTS test_choice (id TEXT PRIMARY KEY, value TEXT)');
  const keepFor = {
    read: () => JSON.parse(db.prepare('SELECT value FROM test_choice WHERE id = ?').get('keep')?.value ?? 'null'),
    write: value => db.prepare('INSERT OR REPLACE INTO test_choice VALUES (?, ?)').run('keep', JSON.stringify(value)),
  };
  return { names, store: setAsideStore(sql, { keepFor, now: () => Date.parse(now), newId: () => 'baseline-held' }), close: () => db.close() };
}
const first = `1f:${'a'.repeat(64)}`, second = `1f:${'b'.repeat(64)}`;

test('the original survives a cold reopen and refuses an occupied restore name without losing the archive', () => {
  const folder = tempFolder(join(tmpdir(), 'archive-original-'));
  let opened;
  try {
    const path = join(folder, 'original.sqlite');
    opened = originalAt(path, '2026-11-01T00:00:00Z');
    opened.names.putNames([{ name: '/note.txt', identity: first, byte_length: 1 }]);
    const stale = opened.store.setAside({ state: 'archived', items: [{ name: '/note.txt', expected_identity: second }] });
    assert.equal(stale.refused[0].code, 'stale_version');
    assert.equal(opened.store.setAside({ state: 'archived', items: [{ name: '/note.txt', expected_identity: first }] }).set_aside.length, 1);
    opened.store.setKeepFor({ after_days: { archived: null } });
    opened.close(); opened = null;
    opened = originalAt(path, '2027-11-01T00:00:00Z');
    assert.equal(opened.store.everything()[0].due_at, null);
    assert.deepEqual(opened.store.sweep(), { moved: [], removed: [] });
    opened.names.putNames([{ name: '/note.txt', identity: second, byte_length: 2 }]);
    assert.match(opened.store.putBack(['baseline-held']).results[0].error, /Another file/);
    assert.equal(opened.store.everything().length, 1);
    opened.names.putNames([{ name: '/note.txt', remove: true }]);
    assert.equal(opened.store.putBack(['baseline-held']).results[0].put_back, true);
    assert.equal(opened.store.everything().length, 0);
  } finally {
    opened?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
