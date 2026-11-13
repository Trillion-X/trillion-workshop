import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeProblems, recipeToolGaps } from '../read-data/recipe-problems.mjs';
import { fileURLToPath } from 'node:url';
import { workshopRows } from '../read-data/workshop-tool-ids.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const kit = read('../kits/the-one-tree/kit.json');
const recipes = read('../recipes/workflows.json').records.map(record => record.payload);
const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));

test('the one-tree kit names three workflows that are published and valid', () => {
  assert.equal(kit.workflows.length, 3);
  for (const id of kit.workflows) {
    const recipe = byId.get(id);
    assert.ok(recipe, `${id} is in recipes/workflows.json`);
    assert.deepEqual(recipeProblems(recipe), [], `${id} has no problems`);
  }
});

test('every workflow the kit reuses is published, and every branch row runs a published workflow', () => {
  const waiting = new Set(kit.waiting_to_publish);
  for (const id of kit.reused_workflows) assert.ok(byId.has(id) || waiting.has(id), `${id} is published or named as waiting`);
  const branchWorkflows = kit.example_rows.map(row => row.value.workflow);
  for (const id of branchWorkflows) assert.ok(byId.has(id) || waiting.has(id), `${id} is published or named as waiting`);
  assert.equal(new Set(kit.example_rows.map(row => row.id)).size, kit.example_rows.length);
});

test('the kit defines each list it writes with a row type and fields, and the worked example input is a valid input for its workflow', () => {
  for (const list of kit.lists) {
    assert.match(list.id, /^list:[a-z-]+$/);
    assert.ok(list.definition.row_type && list.definition.fields.length > 0);
  }
  const recipe = byId.get(kit.worked_example.workflow);
  for (const required of recipe.input_schema.required ?? []) assert.ok(required in kit.worked_example.input, `example gives ${required}`);
});

test('the three workflows name no tool the Workshop lacks', () => {
  const known = new Set(workshopRows(fileURLToPath(new URL('../../', import.meta.url))).map(({ payload }) => payload.id));
  for (const id of kit.workflows) assert.deepEqual(recipeToolGaps(byId.get(id), { known }), [], `${id} has no tool gaps`);
});

test('on a blank account (no workflow rows of its own) each of the three workflows starts from the public recipe and writes one waiting job', async () => {
  const { startARecipeRun } = await import('../read-data/start-a-recipe-run.mjs');
  for (const id of kit.workflows) {
    const kept = new Map();
    const door = {
      read: async (type, rowId) => kept.get(rowId) ?? null,
      list: async function* () {},
      write: async records => { for (const record of records) kept.set(record.id, record); },
    };
    const first = await startARecipeRun({ input: { row: id }, task: { request_key: 'blank-1' } }, { door });
    assert.equal(first.status, 'written');
    assert.deepEqual([...kept.values()][0].value.job, byId.get(id).steps);
    assert.equal((await startARecipeRun({ input: { row: id }, task: { request_key: 'blank-1' } }, { door })).status, 'already-there');
  }
});
