// Making a pursuit its own database: its connection is kept in the vault first (made on the caller's computer, never in a
// step), then the operator's login runs the own-database recipe with it, then the pursuit's own login turns on pgvector and
// reads back who and where it is. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/make-a-database-for-each-pursuit.json', import.meta.url), 'utf8'));
const input = { operator_credential_name: 'made-up-operator-connection', credential_name: 'made-up-pursuit-connection', hosts: 'db.example.com' };
const run = answers => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions, workflow_id: 'workflow:make-a-database-for-each-pursuit', input, answers });
const kept = { name: 'made-up-pursuit-connection', accepted: true, hosts: ['db.example.com'] };
const made = { columns: ['role', 'recipe', 'action', 'valid_until'], rows: [{ role: 'p_made_up', recipe: 'own-database', action: 'create', valid_until: 'infinity' }], row_count: 1 };

test('the pursuit\'s connection is kept first, by name and hosts only', async () => {
  const result = await run({});
  assert.equal(result.status, 'paused');
  const [asked] = result.waiting;
  assert.equal(asked.asks, 'tool:keep-a-secret-by-name');
  assert.deepEqual(asked.input, { arguments: ['made-up-pursuit-connection', '--hosts', 'db.example.com'] });
});

test('then the operator\'s login makes the login and the database it owns with the own-database recipe', async () => {
  const [asked] = (await run({ 'keep-the-login': kept })).waiting;
  assert.equal(asked.asks, 'tool:run-sql-in-my-database');
  assert.deepEqual(asked.input, { credential_name: 'made-up-operator-connection', role_credential_name: 'made-up-pursuit-connection', recipe: { name: 'own-database', action: 'create' } });
});

test('then the pursuit\'s own login turns on search by meaning and reads back who and where it is', async () => {
  const [vector] = (await run({ 'keep-the-login': kept, 'make-the-database': made })).waiting;
  assert.equal(vector.asks, 'tool:run-sql-in-my-database');
  assert.deepEqual(vector.input, { credential_name: 'made-up-pursuit-connection', sql: 'CREATE EXTENSION IF NOT EXISTS vector' });
  const [back] = (await run({ 'keep-the-login': kept, 'make-the-database': made, 'search-by-meaning': { columns: [], rows: [], row_count: 0 } })).waiting;
  assert.equal(back.input.credential_name, 'made-up-pursuit-connection');
  assert.match(back.input.sql, /current_user .* current_database\(\) .* extname = 'vector'/);
  const done = await run({ 'keep-the-login': kept, 'make-the-database': made, 'search-by-meaning': { row_count: 0 }, 'read-it-back': { rows: [{ login: 'p_made_up', database: 'p_made_up', vector: '0.8.0' }] } });
  assert.equal(done.status, 'completed');
});

test('no step\'s input holds a connection string or a password', () => {
  assert.doesNotMatch(JSON.stringify(definitions[0].steps), /postgres(ql)?:\/\/|password/i);
});
