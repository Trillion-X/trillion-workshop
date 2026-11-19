// workflow:keep-the-tools-i-used keeps the person's record of the tools they ran in their own store: one row of its
// tools_i_used table per tool and state, from the tool-ran fact the person's door tells once per tool, state and day.
// The recipe runs on the workflow engine's runner against an empty PostgreSQL database (PGlite), its SQL as
// tool:run-sql-in-my-database would send it. Tool ids and days are made up; the fact's shape is the engine's (ran_fact).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const recipe = JSON.parse(readFileSync(new URL('../recipes/keep-the-tools-i-used.json', import.meta.url), 'utf8')).records[0].payload;
const STORE = { where: 'a made-up database', language: 'SQL (PostgreSQL)', credential_name: 'a-made-up-login' };
const DAY = 86_400_000;
const NOV_19 = Date.UTC(2026, 10, 19);

const door = db => ({
  async run(name, input) {
    assert.equal(name, 'tool:run-sql-in-my-database');
    assert.equal(input.credential_name, STORE.credential_name, 'the login is the one the switch named');
    const result = await db.query(input.sql, input.params ?? []);
    return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.affectedRows ?? result.rows.length };
  },
});
const told = async (db, fact) => {
  const run = await runWorkflow({ recipe, input: { ...recipe.wakes[0].input, store: STORE, fact, fact_id: `${fact.tool}|${fact.state}|${fact.day_ms}` } }, door(db));
  assert.equal(run.status, 'completed', run.error_message ?? JSON.stringify(run.waiting));
};
const kept = async db => (await db.query(`select tool, state, extract(epoch from first_day) * 1000 as first, extract(epoch from last_day) * 1000 as last,
  days_used, last_address, last_cause from tools_i_used order by tool, state`)).rows
  .map(row => ({ ...row, first: Number(row.first), last: Number(row.last) }));

test('a tool told on two days is one row that counts both days, and told twice on one day counts it once', async () => {
  const db = new PGlite();
  const fact = { tool: 'tool:find-a-thing', state: 'answered', day_ms: NOV_19 };
  await told(db, fact);
  await told(db, fact);
  await told(db, { ...fact, day_ms: NOV_19 + DAY });
  assert.deepEqual(await kept(db), [{ tool: 'tool:find-a-thing', state: 'answered', first: NOV_19, last: NOV_19 + DAY, days_used: 2, last_address: null, last_cause: null }]);
});

test('a refused run is its own row with its cause, beside the answered one', async () => {
  const db = new PGlite();
  await told(db, { tool: 'tool:x', state: 'answered', day_ms: NOV_19 });
  await told(db, { tool: 'tool:x', state: 'refused', day_ms: NOV_19, address: 'https://mcp.example/mcp', cause: 'engine::a@src/a.rs:1:1:condition: tools_tool_keys_share_no_host#unknown' });
  const rows = await kept(db);
  assert.deepEqual(rows.map(row => [row.state, row.last_cause]), [['answered', null], ['refused', 'engine::a@src/a.rs:1:1:condition: tools_tool_keys_share_no_host#unknown']]);
  assert.equal(rows[1].last_address, 'https://mcp.example/mcp');
});

test('a later fact with no address keeps the address an earlier one named', async () => {
  const db = new PGlite();
  await told(db, { tool: 'tool:remote', state: 'answered', day_ms: NOV_19, address: 'https://mcp.example/mcp' });
  await told(db, { tool: 'tool:remote', state: 'answered', day_ms: NOV_19 + DAY });
  assert.equal((await kept(db))[0].last_address, 'https://mcp.example/mcp');
});

test('a fact told late, for an earlier day, moves the first day back and never the last day', async () => {
  const db = new PGlite();
  await told(db, { tool: 'tool:late', state: 'answered', day_ms: NOV_19 + 2 * DAY });
  await told(db, { tool: 'tool:late', state: 'answered', day_ms: NOV_19 });
  const [row] = await kept(db);
  assert.deepEqual([row.first, row.last], [NOV_19, NOV_19 + 2 * DAY]);
});

test('the recipe hears only the door\'s tool-ran fact and asks only the person\'s store', () => {
  assert.deepEqual(recipe.wakes.map(wake => wake.on), [{ fact: { kind: 'tool-ran', from: ['door'] } }]);
  assert.deepEqual(recipe.records, { runs: ['tool:run-sql-in-my-database'] });
});
