import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mergeTaskShardQueuePages, spaceTaskQueuePage } from '../src/space-task-shard-query.mjs';

function queueDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE space_handoffs (
    space_id TEXT, handoff_id TEXT, open INTEGER, value TEXT, priority INTEGER,
    handed_at TEXT, to_agent TEXT, prefer_until TEXT
  )`);
  const sql = { exec(query, ...binds) {
    const statement = db.prepare(query);
    const rows = /^\s*(select|with)/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []);
    return { toArray: () => rows.map(row => ({ ...row })) };
  } };
  return { db, sql };
}

test('one-Space queue pages merge task owners in exact priority and stable cursor order', () => {
  const { db, sql } = queueDb();
  const add = (handoff_id, priority, handed_at, to_agent = null, prefer_until = '') => sql.exec(
    'INSERT INTO space_handoffs VALUES (?,?,?,?,?,?,?,?)', 'company', handoff_id, 1,
    JSON.stringify({ handoff_id, priority, handed_at, to_agent }), priority, handed_at, to_agent, prefer_until,
  );
  add('old-high', 9, '2026-10-13T00:00:00Z');
  add('new-high', 9, '2026-10-13T00:00:01Z');
  add('medium', 3, '2026-10-13T00:00:00Z');
  add('not-yet-preferred', 100, '2026-10-12T00:00:00Z', 'other', '2026-10-14T00:00:00Z');
  const localA = spaceTaskQueuePage(sql, { space_id: 'company', now_iso: '2026-10-13T12:00:00Z', limit: 2 });
  const localB = { items: [{ handoff_id: 'different-owner', priority: 8, handed_at: '2026-10-13T00:00:00Z' }], more: false };
  const merged = mergeTaskShardQueuePages([localA, localB], 3);
  assert.deepEqual(merged.items.map(row => row.handoff_id), ['old-high', 'new-high', 'different-owner']);
  const next = spaceTaskQueuePage(sql, { space_id: 'company', now_iso: '2026-10-13T12:00:00Z', after: merged.next_cursor, limit: 2 });
  assert.deepEqual(next.items.map(row => row.handoff_id), ['medium']);
  assert.equal(next.more, false);
  db.close();
});

test('named queue pages stay addressed and candidate reads remain bounded', () => {
  const { db, sql } = queueDb();
  for (let i = 0; i < 7; i++) sql.exec('INSERT INTO space_handoffs VALUES (?,?,?,?,?,?,?,?)', 'company', `h${i}`, 1,
    JSON.stringify({ handoff_id: `h${i}`, priority: i, handed_at: `2026-10-13T00:00:0${i}Z` }), i,
    `2026-10-13T00:00:0${i}Z`, i === 5 ? 'agent' : 'someone-else', '');
  const page = spaceTaskQueuePage(sql, { space_id: 'company', to_agent: 'agent', now_iso: '2026-10-13T12:00:00Z', limit: 2 });
  assert.deepEqual(page.items.map(row => row.handoff_id), ['h5']);
  assert.equal(page.more, false);
  db.close();
});
