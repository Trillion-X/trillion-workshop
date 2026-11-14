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

test('every workflow the kit reuses is published, and no branch is listed in the kit', () => {
  const waiting = new Set(kit.waiting_to_publish);
  for (const id of kit.reused_workflows) assert.ok(byId.has(id) || waiting.has(id), `${id} is published or named as waiting`);
  assert.equal(new Set(kit.example_rows.map(row => row.id)).size, kit.example_rows.length);
  assert.deepEqual(kit.lists.filter(list => /branch/.test(list.id)).map(list => list.id), [], 'branches are the workflows themselves, never a list');
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

test('every condition a published workflow carries is one the formulas engine evaluates, and keeps a part with its tags', async () => {
  const { filterRecords } = await import('../../formulas/do-work/requests.mjs');
  const carrying = recipes.filter(recipe => recipe.fires_when);
  assert.ok(carrying.length >= 16, "the published workflows that were branches carry their conditions");
  for (const recipe of carrying) {
    for (const item of recipe.fires_when) {
      const { fields: reads, tree } = item.condition;
      // A made-up part with every tag the condition names: the condition keeps it, and a part with none is not kept by it.
      const tags = JSON.stringify(tree).match(/"values":\[[^\]]*\]/g)?.flatMap(found => JSON.parse(`{${found}}`).values) ?? [];
      const full = { words: 'made up', kinds: tags, subjects: ['made-up subject'], people: ['made-up person'], niches: ['made-up niche'], own_words: true };
      const empty = { words: 'made up', kinds: [], subjects: [], people: [], niches: [], own_words: false };
      const result = filterRecords({ records: [full, empty], fields: reads, tree });
      assert.deepEqual(result.incomplete, [], `${recipe.id} "${item.label}" has no unfinished rule`);
      assert.deepEqual(result.matches, [0], `${recipe.id} "${item.label}" keeps the part that meets it and only that one`);
    }
  }
});

test('the trunk carries one daily wake, chooses from every workflow, heals into workflow rows and passes the run-wide agents override', () => {
  const recipe = byId.get('workflow:grow-the-one-tree');
  assert.deepEqual(recipe.wakes.map(wake => [wake.id, wake.input.start_at]), [['daily', 'learn-and-prune']]);
  const stepOf = id => recipe.steps.find(step => step.id === id);
  assert.match(stepOf('choose-branches').do, /tool:choose-the-workflows-that-fire/);
  assert.match(stepOf('choose-branches').do, /tool:filter-rows-by-rules/);
  assert.match(stepOf('fan-out').do, /agents_per_step/);
  assert.match(stepOf('fan-out').do, /new workflow row/);
  assert.doesNotMatch(JSON.stringify(recipe), /tree-branch/, 'no step reads a list of branches');
  assert.match(stepOf('plant-the-seed').do, /cause/);
  assert.ok(!recipe.input_schema.required.includes('seed'), 'a woken run takes its seeds from its cause');
});

test('a broad condition the trunk reports is written as a row the rewrite workflow wakes on, and only a Waiting row starts it', async () => {
  const trunk = byId.get('workflow:grow-the-one-tree');
  const rewrite = byId.get('workflow:rewrite-a-broad-condition');
  assert.ok(rewrite, 'workflow:rewrite-a-broad-condition is published');
  assert.deepEqual(recipeProblems(rewrite), []);
  const [wake] = rewrite.wakes;
  const choose = trunk.steps.find(step => step.id === 'choose-branches').do;
  // The trunk writes the rows under the prefix the wake listens to, and the arrival source the wake names when absent.
  assert.match(choose, new RegExp(`id ${wake.on.record.prefix}`));
  assert.ok(choose.includes(wake.input.arrival_source), 'choose-branches writes the arrival source the wake names');
  assert.equal(wake.input.start_at, rewrite.steps[0].id);
  // The source row choose-branches writes keeps a Waiting row and drops a Done one, so marking a row Done starts nothing.
  const { filterRecords } = await import('../../formulas/do-work/requests.mjs');
  const { fields, tree } = JSON.parse(choose.match(/filter: the text (\{.*?\}\}\]\}\}), seed/)[1]);
  const result = filterRecords({ records: [{ status: 'Waiting' }, { status: 'Done' }], fields, tree });
  assert.deepEqual(result.incomplete, []);
  assert.deepEqual(result.matches, [0]);
  assert.match(trunk.steps.find(step => step.id === 'learn-and-prune').do, /record:calendar-task:one-tree-overrides-YEAR-MONTH-DAY/);
});
