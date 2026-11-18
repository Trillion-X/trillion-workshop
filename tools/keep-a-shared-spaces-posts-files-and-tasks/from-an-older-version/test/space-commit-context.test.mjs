import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { guardSpaceSql, withSpaceCommitContext, captureSpaceCommit } from '../src/space-commit-context.mjs';
function fixture() {
  const state = new Map([['one', 'member'], ['two', 'member']]);
  const writes = [];
  const owner = { spaceAccessState: id => state.get(id) };
  const sql = guardSpaceSql(owner, { exec(query, id) { writes.push([query, id]); if (query.startsWith('UPDATE policy')) state.set(id, 'changed'); return { toArray: () => [] }; } });
  const capture = spaceId => captureSpaceCommit(owner, { spaceId, relay: 'actor', state: state.get(spaceId), deadline: Infinity });
  return { state, writes, owner, sql, capture };
}
test('a policy revoked during an await prevents the SQL commitment itself', async () => {
  const f = fixture();
  let release, entered;
  const holding = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const command = withSpaceCommitContext(f.owner, async () => { f.capture('one'); entered(); await holding; f.sql.exec('INSERT INTO content', 'one'); });
  await reached;
  f.state.set('one', 'revoked'); release();
  await assert.rejects(command, /before commitment/);
  assert.equal(f.writes.length, 0);
});
test('separate concurrent invocations retain separate resource policy captures', async () => {
  const f = fixture();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = withSpaceCommitContext(f.owner, async () => { f.capture('one'); await hold; f.sql.exec('INSERT INTO content', 'one'); });
  await withSpaceCommitContext(f.owner, async () => { f.capture('two'); f.sql.exec('INSERT INTO content', 'two'); });
  f.state.set('one', 'revoked'); release();
  await assert.rejects(first, /before commitment/);
  assert.deepEqual(f.writes, [['INSERT INTO content', 'two']]);
});
test('nested owner methods preserve the outer authorization capture', async () => {
  const f = fixture();
  await assert.rejects(withSpaceCommitContext(f.owner, async () => {
    f.capture('one'); f.state.set('one', 'revoked');
    return withSpaceCommitContext(f.owner, () => f.sql.exec('DELETE FROM members', 'one'));
  }), /before commitment/);
  assert.equal(f.writes.length, 0);
});
test('a permitted policy edit advances only its own synchronous precondition', async () => {
  const f = fixture();
  await withSpaceCommitContext(f.owner, async () => {
    f.capture('one'); f.sql.exec('UPDATE policy', 'one'); f.sql.exec('INSERT INTO notice', 'one');
  });
  assert.deepEqual(f.writes.map(([query]) => query), ['UPDATE policy', 'INSERT INTO notice']);
});

test('a content owner builds its derived discovery cache without gaining a policy writer', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE memberships (id TEXT PRIMARY KEY); INSERT INTO memberships VALUES (\'space-a\'); CREATE TABLE space_open_index (space_id TEXT PRIMARY KEY, open INTEGER)');
    const owner = { contentPolicyTarget: true };
    const sql = guardSpaceSql(owner, { exec(query) { db.exec(query); return { toArray: () => [] }; } });
    sql.exec('CREATE TRIGGER derived_cache AFTER DELETE ON memberships BEGIN DELETE FROM space_open_index WHERE space_id = OLD.id; END');
    sql.exec('INSERT INTO space_open_index SELECT id, 0 FROM memberships');
    sql.exec('DELETE FROM space_open_index WHERE space_id IN (SELECT id FROM memberships)');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM space_open_index').get().n, 0);
    assert.throws(() => sql.exec('DELETE FROM memberships'), /read-only/);
    assert.throws(() => sql.exec('UPDATE "memberships" SET id = \'space-b\''), /read-only/);
    assert.equal(db.prepare('SELECT id FROM memberships').get().id, 'space-a');
  } finally { db.close(); }
});
