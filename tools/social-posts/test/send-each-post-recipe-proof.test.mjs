// The recipe that replaced tool:send-each-post-at-its-time (tools/workflows/recipes/send-each-post-at-its-time.json) is proven
// here: the SQL of its steps runs on PGlite and the same attempts run on a JSON folder, every answer must be the one its
// `expect` names, and both stores must answer alike. Everything here is made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const recipe = JSON.parse(readFileSync(new URL('../../workflows/recipes/send-each-post-at-its-time.json', import.meta.url), 'utf8')).records[0].payload;
const stepNamed = id => recipe.steps.find(step => step.id === id);
const prove = stepNamed('prove');
const attempts = JSON.parse(prove.do.slice(prove.do.indexOf('[')));

async function pgStore() {
  const db = new PGlite();
  await db.query('create table objects (address text primary key, type text not null, value jsonb not null, version integer not null)');
  return {
    async seed(op) { await db.query('insert into objects (address, type, value, version) values ($1, $2, $3, $4)', [op.address, op.type, JSON.stringify(op.value ?? null), op.version]); },
    async due() {
      const step = stepNamed('read-due-posts');
      return (await db.query(step.sql, [step.params])).rows.map(row => row.address);
    },
    async connections(addresses) {
      return (await db.query(stepNamed('read-connections').sql, [addresses])).rows.map(row => row.address);
    },
    async write(address, expectedVersion, value) {
      const result = await db.query(stepNamed('keep-sent-posts').sql, [address, JSON.stringify(value), expectedVersion]);
      return result.affectedRows === 1 ? 'written' : 'conflict';
    },
    async close() { await db.close(); },
  };
}

function folderStore() {
  const dir = tempFolder(join(tmpdir(), 'send-each-recipe-proof-'));
  const fileOf = address => join(dir, `${encodeURIComponent(address)}.json`);
  const load = address => { try { return JSON.parse(readFileSync(fileOf(address), 'utf8')); } catch { return null; } };
  const all = () => readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).address);
  return {
    async seed(op) { writeFileSync(fileOf(op.address), JSON.stringify({ address: op.address, type: op.type, value: op.value ?? null, version: op.version })); },
    async due() {
      const step = stepNamed('read-due-posts');
      return all().filter(address => {
        const row = load(address);
        return row.type === 'post' && step.params.includes(row.value.status) && 'armed_at' in row.value && Date.parse(row.value.scheduled_for) <= Date.now();
      }).sort();
    },
    async connections(addresses) { return addresses.filter(address => load(address) !== null); },
    async write(address, expectedVersion, value) {
      const row = load(address);
      if (row.version !== expectedVersion) return 'conflict';
      writeFileSync(fileOf(address), JSON.stringify({ ...row, value, version: row.version + 1 }));
      return 'written';
    },
    async close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// Runs the attempts in order; each answer is checked against its `expect` and returned for the comparison of the two stores.
async function runAttempts(store) {
  const answers = [];
  for (const [at, op] of attempts.entries()) {
    if (op.op === 'seed') { await store.seed(op); answers.push({ seeded: op.address }); continue; }
    if (op.op === 'due') { const found = (await store.due()).sort(); assert.deepEqual(found, [...op.expect].sort(), `attempt ${at + 1} due posts`); answers.push({ due: found }); continue; }
    if (op.op === 'connections') { const found = await store.connections(op.addresses); assert.deepEqual(found, op.expect, `attempt ${at + 1} connections`); answers.push({ connections: found }); continue; }
    if (op.op === 'write') { const answer = await store.write(op.address, op.expected_version, op.value); assert.equal(answer, op.expect, `attempt ${at + 1} write`); answers.push({ write: answer }); continue; }
    throw new Error(`unknown attempt ${op.op}`);
  }
  return answers;
}

test('send-each-post-at-its-time: the recipe names no records door method and its prove step has its attempts', () => {
  assert.doesNotMatch(JSON.stringify(recipe), /records:(read|write|list)/);
  assert.ok(attempts.filter(op => op.op === 'due').length >= 2, 'the due read is proven before and after a write');
});

test('send-each-post-at-its-time: its attempts give every expected answer on PGlite and on a JSON folder, alike', async () => {
  const pg = await pgStore();
  const pgAnswers = await runAttempts(pg);
  await pg.close();
  const folder = folderStore();
  const folderAnswers = await runAttempts(folder);
  await folder.close();
  assert.deepEqual(folderAnswers, pgAnswers, 'PGlite and the JSON folder answer alike');
  console.log(`PROVE workflow:send-each-post-at-its-time: ${attempts.length} attempts, PGlite and JSON folder alike`);
});
