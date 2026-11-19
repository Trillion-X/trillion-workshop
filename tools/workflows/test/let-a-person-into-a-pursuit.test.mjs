// Proof of the three workflows of tools/workflows/recipes/let-a-person-into-a-pursuit.json: the requests their steps give
// tool:run-sql-in-my-database are ones that tool takes (its own shapeOf), the verifier the join step makes is one the let-in
// step accepts, and the statements the recipes carry run on PGlite, a plain PostgreSQL. The login itself, made from the
// verifier and signed in with the password only its keeper holds, is proved on a real server in
// tools/run-sql-in-my-database/test/run-sql.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { shapeOf } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { verifierOf } from '../../run-sql-in-my-database/do-work/make-a-login-verifier.mjs';

const recipes = Object.fromEntries(JSON.parse(readFileSync(new URL('../recipes/let-a-person-into-a-pursuit.json', import.meta.url), 'utf8')).records.map(({ payload }) => [payload.id, payload]));
const join = recipes['workflow:join-a-pursuit-with-a-password-only-i-keep'];
const letIn = recipes['workflow:let-a-person-into-a-pursuit'];
const takeOut = recipes['workflow:take-a-person-out-of-a-pursuit'];
const statement = (recipe, stepId, name) => recipe.steps.find(step => step.id === stepId).sql.find(item => item.name === name).text;

test('the verifier the join workflow makes is what the let-in workflow and the tool accept', () => {
  const verifier = verifierOf(randomBytes(32).toString('base64url'));
  assert.match(verifier, new RegExp(letIn.input_schema.properties.password_verifier.pattern));
  assert.match(verifier, new RegExp(join.steps.find(step => step.id === 'make-the-verifier').submit.properties.password_verifier.pattern));
  const made = shapeOf({ database: 'p', recipe: { name: 'may-change-rows', action: 'create', role: 'sam_coach', password_verifier: verifier } });
  assert.equal(made.verifier, verifier);
  const until = shapeOf({ database: 'p', recipe: { name: 'may-change-rows', action: 'create', role: 'sam_coach', password_verifier: verifier, valid_until: '2027-01-01T00:00:00Z' } });
  assert.equal(until.validUntil, '2027-01-01T00:00:00Z');
  assert.equal(shapeOf({ database: 'p', recipe: { name: 'may-change-rows', action: 'drop', role: 'sam_coach' } }).action, 'drop');
});

test('a role name the workflows take is one Postgres takes unquoted, and a name it would not take is refused', () => {
  const pattern = new RegExp(letIn.input_schema.properties.role.pattern);
  for (const name of ['sam_coach', '_x', 'a'.repeat(63)]) assert.ok(pattern.test(name), name);
  for (const name of ['Sam', 'sam-coach', '1sam', 'a'.repeat(64), 'sam coach', '']) assert.ok(!pattern.test(name), name);
  assert.equal(join.input_schema.properties.role.pattern, letIn.input_schema.properties.role.pattern);
  assert.equal(takeOut.input_schema.properties.role.pattern, letIn.input_schema.properties.role.pattern);
});

test('where-they-connect names the database and a port, and gone says a dropped login is gone', async () => {
  const db = new PGlite();
  const [where] = (await db.query(statement(letIn, 'where-they-connect', 'where'))).rows;
  assert.equal(typeof where.database, 'string');
  assert.ok(where.database.length > 0);
  assert.equal(typeof where.address, 'string');
  assert.ok(Number.isInteger(where.port));
  await db.exec('CREATE ROLE sam_coach');
  assert.deepEqual((await db.query(statement(takeOut, 'take-them-out', 'gone'), ['sam_coach'])).rows, [{ gone: false }]);
  await db.exec('DROP ROLE sam_coach');
  assert.deepEqual((await db.query(statement(takeOut, 'take-them-out', 'gone'), ['sam_coach'])).rows, [{ gone: true }]);
});

test('no step sends or asks for a password: only the verifier and the role travel', () => {
  for (const recipe of [join, letIn, takeOut]) {
    for (const step of recipe.steps) {
      const fields = Object.keys(step.submit?.properties ?? {});
      assert.ok(!fields.some(field => /password$|secret|connection/.test(field)), `${recipe.id} ${step.id} answers ${fields}`);
    }
    assert.ok(!Object.keys(recipe.input_schema.properties).some(field => /password$|secret|connection/.test(field)), recipe.id);
  }
});
