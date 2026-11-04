// test/proof-per-run.test.mjs
// The authority proof a Namespace command makes before its SQL statements (src/proof-per-run.mjs) runs once for statements that follow
// one another synchronously, so a lookup of 600 names fits the command's 1,280-statement bound; it runs again after any await, after a
// statement that writes, and for another command, and a revoked authority still refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proofPerRun } from '../src/proof-per-run.mjs';
import useData from '../../shared-code/src/metered-use.json' with { type: 'json' };

const BOUND = useData.most_held_statements;

function guarded(sql = {}) {
  let proofs = 0, revoked = false;
  const proof = proofPerRun(() => { proofs += 1; if (revoked) throw Object.assign(new Error('The shared authority cancelled this Namespace permit.'), { status: 403 }); });
  let statements = 0;
  const exec = (current, query) => { proof.before(current); statements += 1; proof.after(query); };
  return { exec, revoke: () => { revoked = true; }, get proofs() { return proofs; }, get statements() { return statements; } };
}

test('a lookup of 600 names proves its authority once, and its statements plus proofs fit the bound', () => {
  const g = guarded();
  const command = {};
  for (let name = 0; name < 600; name += 1) g.exec(command, 'SELECT * FROM namespace_files WHERE name = ?');
  assert.equal(g.proofs, 1);
  assert.ok(g.statements + g.proofs <= BOUND, `${g.statements + g.proofs} statements against a bound of ${BOUND}`);
});

test('the proof is made again after an await, after a write, and for another command', async () => {
  const g = guarded();
  const command = {};
  g.exec(command, 'SELECT 1');
  g.exec(command, 'SELECT 1');
  assert.equal(g.proofs, 1);
  await null;
  g.exec(command, 'SELECT 1');
  assert.equal(g.proofs, 2, 'after an await');
  g.exec(command, 'INSERT INTO t VALUES (1)');
  g.exec(command, 'SELECT 1');
  assert.equal(g.proofs, 3, 'a write is proved with its run, and the statement after it proves again');
  g.exec({}, 'SELECT 1');
  assert.equal(g.proofs, 4, 'another command');
});

test('an authority revoked while the command awaits refuses its next statement', async () => {
  const g = guarded();
  const command = {};
  g.exec(command, 'SELECT 1');
  g.revoke();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.throws(() => g.exec(command, 'SELECT 1'), error => error.status === 403);
});
