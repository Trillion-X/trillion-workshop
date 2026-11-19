// workflow:tell-when-a-wake-stops and workflow:check-my-code-against-my-rules tell the person by keeping a notice in the
// person's own store: one row of its notices table, the table workflow:read-my-notices and the person's devices read
// (workflow:read-my-device-notices), made once by the run with the devices table it points at.
// Each recipe runs on the workflow engine's runner against an empty PostgreSQL database (PGlite), its SQL as
// tool:run-sql-in-my-database would send it. Every value is made up except the wake-failed fact, the one the engine kept
// on Nov 19 2026 at 10:40 AM CST with its crate name left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const recipe = name => JSON.parse(readFileSync(new URL(`../recipes/${name}.json`, import.meta.url), 'utf8')).records[0].payload;
const STORE = { where: 'a made-up database', language: 'SQL (PostgreSQL)', credential_name: 'a-made-up-login' };

/** A door that runs the store's SQL on `db` and answers every other tool from `answers`. */
function door(db, answers = {}) {
  return {
    async run(name, input) {
      if (name === 'tool:run-sql-in-my-database') {
        assert.equal(input.credential_name, STORE.credential_name, 'the login is the one the switch named');
        const result = await db.query(input.sql, input.params ?? []);
        return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.affectedRows ?? result.rows.length };
      }
      return answers[name](input);
    },
  };
}
const kept = async db => (await db.query('select id, kind, title, body, key, made_at, read_at from notices order by id')).rows;

test('a stopped wake is kept once as a needs-you notice that says its cause, however often its fact is told', async () => {
  const stops = recipe('tell-when-a-wake-stops');
  const db = new PGlite();
  const fact = { tool: 'workflow:route-each-row-change', wake: 'a-row-changed',
    cause: 'engine::wake::tool_runner@src/wake/tool_runner.rs:265:51:condition: declaration_changed_switch_on_again#04fbc0d25' };
  const input = { ...stops.wakes[0].input, store: STORE, fact, fact_id: 'db4f00bf5c8a8423c823c5d8e0d05840742f34c2cd105faf3af8c34bd5550b75' };
  for (let told = 0; told < 2; told += 1) {
    const run = await runWorkflow({ recipe: stops, input }, door(db));
    assert.equal(run.status, 'completed', run.error_message ?? JSON.stringify(run.waiting));
  }
  const rows = await kept(db);
  assert.equal(rows.length, 1, 'the same fact is one notice');
  assert.equal(rows[0].kind, 'needs-you');
  assert.equal(rows[0].title, `workflow:route-each-row-change a-row-changed stopped: ${fact.cause}`);
  assert.match(rows[0].body, /Its tool row changed since you switched it on/);
  assert.equal(rows[0].key, input.fact_id);
  assert.equal(rows[0].read_at, null);
  // A device registered before it reads it, by the device workflow's own statement.
  const device = JSON.parse(readFileSync(new URL('../recipes/read-my-device-notices.json', import.meta.url), 'utf8')).records[0].payload
    .steps.find(step => step.id === 'answer').sql.find(statement => statement.name === 'notices').text;
  await db.query("insert into devices (id, platform, registered_at) values ('a-phone', 'apns', now() - interval '1 hour')");
  assert.deepEqual((await db.query(device, ['a-phone', 0, 20])).rows.map(row => row.title), [rows[0].title]);
});

test('a repository that breaks a rule is one notice, and one that keeps every rule is none', async () => {
  const code = recipe('check-my-code-against-my-rules');
  const db = new PGlite();
  const answer = archive => ({ passed: !archive.includes('broken'), said: `said for ${archive}` });
  const checks = ['https://code-host.example/broken.tar.gz', 'https://code-host.example/fine.tar.gz'].map(archive => ({ archive, rules: [] }));
  const hands = door(db, { 'tool:check-an-archive-against-my-rules': input => answer(input.archive) });
  const run = await runWorkflow({ recipe: code, input: { ...code.wakes[0].input, store: STORE, checks } }, hands);
  assert.equal(run.status, 'completed', run.error_message ?? JSON.stringify(run.waiting));
  const rows = await kept(db);
  assert.deepEqual(rows.map(row => [Number(row.id), row.title, row.body]),
    [[1, 'My rules found something in https://code-host.example/broken.tar.gz', 'said for https://code-host.example/broken.tar.gz']]);
});
