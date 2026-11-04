import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

test('a folder page streams name rows instead of materializing the SQLite result', () => {
  const host = sqliteHost(':memory:');
  const sql = { exec(query, ...values) {
    const cursor = host.sql.exec(query, ...values);
    if (!query.includes('FROM namespace_names WHERE collection = ? AND name > ?')) return cursor;
    return new Proxy(cursor, { get(target, key) {
      if (key === 'toArray') return () => { throw new Error('folder page was materialized'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const names = namespaceStore(sql);
  host.sql.exec('INSERT INTO namespace_names (name, collection, identity, byte_length, named_at) VALUES (?, ?, NULL, NULL, ?)', '/Sites/a.html', '/Sites', '2026-10-05');
  host.sql.exec('INSERT INTO namespace_names (name, collection, identity, byte_length, named_at) VALUES (?, ?, NULL, NULL, ?)', '/Sites/b.html', '/Sites', '2026-10-05');
  assert.deepEqual(names.listNames('/Sites', '', 1).names.map(row => row.name), ['/Sites/a.html']);
  assert.equal(names.listNames('/Sites', '', 1).next_after, '/Sites/a.html');
});
