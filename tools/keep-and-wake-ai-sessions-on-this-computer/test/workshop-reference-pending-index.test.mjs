import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { workshopReferenceIndex } from '../../shared-code/src/workshop-facts.mjs';

test('Workshop pending reference marker lookup uses the partial kind index', () => {
  const host = sqliteHost(':memory:');
  host.sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL, value TEXT NOT NULL)');
  workshopReferenceIndex(host.sql);
  host.sql.exec('UPDATE workshop_references_filled SET done = 1');
  for (let i = 0; i < 1000; i += 1) {
    host.sql.exec('INSERT INTO workshop_references_filled (kind, after, done) VALUES (?, ?, 1)', `complete:${i}`, `complete:${i}`);
  }
  host.sql.exec("INSERT INTO workshop_references_filled (kind, after, done) VALUES ('pending:', 'pending:', 0)");

  const plan = host.sql.exec('EXPLAIN QUERY PLAN SELECT kind, after FROM workshop_references_filled WHERE done = 0 ORDER BY kind LIMIT 1').toArray();
  assert.ok(plan.some(row => /workshop_references_filled_pending/.test(row.detail)), JSON.stringify(plan));
});
