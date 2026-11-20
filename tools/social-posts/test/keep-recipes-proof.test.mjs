// The two recipes that replaced the snippet and conversation-summary rows (tools/workflows/recipes/keep-the-persons-snippets.json
// and keep-conversation-summaries.json) are proven here: the operations of each recipe's prove step run through the store's
// own objects on PGlite and on a JSON folder, every answer must be the one its `expect` names, and both stores must answer
// alike. Everything here is made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const recipeFile = name => new URL(`../../workflows/recipes/${name}.json`, import.meta.url);
const proveOps = payload => {
  const step = payload.steps.find(found => found.id === 'prove');
  return JSON.parse(step.do.slice(step.do.indexOf('[')));
};

async function pgStore() {
  const db = new PGlite();
  await db.query('create table objects (address text primary key, type text not null, value jsonb not null, version integer not null)');
  return {
    async read(address) {
      const found = await db.query('select value, version from objects where address = $1', [address]);
      return found.rows[0] ? { value: found.rows[0].value, version: found.rows[0].version } : null;
    },
    async insert(address, type, value) { await db.query('insert into objects (address, type, value, version) values ($1, $2, $3, 1)', [address, type, JSON.stringify(value)]); },
    async update(address, value, version) { await db.query('update objects set value = $2, version = $3 where address = $1', [address, JSON.stringify(value), version]); },
    async remove(address) { await db.query('delete from objects where address = $1', [address]); },
    async count(type) { return (await db.query('select count(*)::int as n from objects where type = $1', [type])).rows[0].n; },
    async close() { await db.close(); },
  };
}

function folderStore() {
  const dir = tempFolder(join(tmpdir(), 'keep-recipe-proof-'));
  const fileOf = address => join(dir, `${encodeURIComponent(address)}.json`);
  const load = address => { try { return JSON.parse(readFileSync(fileOf(address), 'utf8')); } catch { return null; } };
  return {
    async read(address) { const found = load(address); return found ? { value: found.value, version: found.version } : null; },
    async insert(address, type, value) { writeFileSync(fileOf(address), JSON.stringify({ type, value, version: 1 })); },
    async update(address, value, version) { writeFileSync(fileOf(address), JSON.stringify({ type: load(address).type, value, version })); },
    async remove(address) { rmSync(fileOf(address)); },
    async count(type) { return readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))).filter(found => found.type === type).length; },
    async close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// Each operation of the prove step, through the store's objects. A write with expected_version null must find no object;
// a number must match the object's version; a stale or missing one conflicts and changes nothing.
async function runOps(store, ops) {
  const answers = [];
  for (const op of ops) {
    const type = op.address?.split(':')[0];
    const current = op.address ? await store.read(op.address) : null;
    let answer;
    if (op.op === 'write') {
      if (op.expected_version === null) {
        if (current) answer = { answer: 'conflict' };
        else { await store.insert(op.address, type, op.value); answer = { answer: 'written', version: 1 }; }
      } else if (!current || current.version !== op.expected_version) answer = { answer: 'conflict' };
      else { await store.update(op.address, op.value, current.version + 1); answer = { answer: 'written', version: current.version + 1 }; }
    } else if (op.op === 'read') {
      answer = current ? { answer: 'found', version: current.version, value: current.value } : { answer: 'missing' };
    } else if (op.op === 'delete') {
      if (!current) answer = { answer: 'missing' };
      else if (current.version !== op.expected_version) answer = { answer: 'conflict' };
      else { await store.remove(op.address); answer = { answer: 'deleted' }; }
    } else if (op.op === 'list') {
      answer = { answer: 'count', count: await store.count(op.type) };
    } else throw new Error(`unknown op ${op.op}`);
    answers.push(answer);
  }
  return answers;
}

function assertAnswers(ops, answers) {
  ops.forEach((op, index) => {
    if (!op.expect) return;
    assert.equal(answers[index].answer, op.expect, `operation ${index + 1} (${op.op}) answered ${JSON.stringify(answers[index])}`);
    if (op.version !== undefined) assert.equal(answers[index].version, op.version, `operation ${index + 1} version`);
    if (op.count !== undefined) assert.equal(answers[index].count, op.count, `operation ${index + 1} count`);
  });
}

for (const name of ['keep-the-persons-snippets', 'keep-conversation-summaries']) {
  test(`${name}: its prove step gives every expected answer on PGlite and on a JSON folder, alike`, async () => {
    const recipe = JSON.parse(readFileSync(recipeFile(name), 'utf8')).records[0].payload;
    assert.doesNotMatch(JSON.stringify(recipe), /records:(read|write|list)/, 'the recipe names no records door method');
    const ops = proveOps(recipe);
    assert.ok(ops.length >= 9, 'the prove step has its example attempts');
    const pg = await pgStore();
    const pgAnswers = await runOps(pg, ops);
    await pg.close();
    const folder = folderStore();
    const folderAnswers = await runOps(folder, ops);
    await folder.close();
    assertAnswers(ops, pgAnswers);
    assertAnswers(ops, folderAnswers);
    assert.deepEqual(folderAnswers, pgAnswers, 'PGlite and the JSON folder answer alike');
    console.log(`PROVE ${name}: ${ops.length} operations, PGlite and JSON folder alike`);
  });
}
