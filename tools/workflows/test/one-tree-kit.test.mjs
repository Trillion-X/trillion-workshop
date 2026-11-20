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

test('on a blank account (no workflow rows of its own) each of the three workflows runs from the public recipe on the workflow engine, paused at its first step', async () => {
  const { runWorkflow } = await import('../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs');
  for (const id of kit.workflows) {
    const run = await runWorkflow({ row: id });
    assert.equal(run.status, 'paused', `${id}: ${run.error_message}`);
    assert.equal(run.waiting[0].step_id, byId.get(id).steps[0].id);
    assert.deepEqual(run.definition.steps.filter(step => step.kind === 'ask').map(step => step.id), byId.get(id).steps.map(step => step.id));
  }
});

test('every condition a published workflow carries is one the formulas engine evaluates, and keeps a part with its tags', async () => {
  const { initSync, filterRecords } = await import('../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js');
  initSync({ module: (await import('node:fs')).readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
  const carrying = recipes.filter(recipe => recipe.fires_when);
  assert.ok(carrying.length >= 16, "the published workflows that were branches carry their conditions");
  for (const recipe of carrying) {
    for (const item of recipe.fires_when) {
      const { fields: reads, tree } = item.condition;
      // A made-up part holding, at each field the condition reads, the values its rules name (a list for a tags field, the
      // first value for any other): the condition keeps it, and a part holding none of them is not kept by it.
      const full = { words: 'made up', subjects: ['made-up subject'], people: ['made-up person'], niches: ['made-up niche'], own_words: true };
      const empty = { words: 'made up', kinds: [], subjects: [], people: [], niches: [], own_words: false };
      const walk = node => (node?.kind === 'group' ? node.rules.flatMap(walk) : node?.kind === 'rule' ? [node] : []);
      for (const rule of walk(tree)) {
        const field = reads.find(read => read.id === rule.field);
        const values = rule.params?.values;
        if (!field || !Array.isArray(values)) continue;
        const [at] = field.path ?? [field.id];
        full[at] = field.kind === 'tags' ? [...new Set([...(full[at] ?? []), ...values])] : values[0];
        if (field.kind !== 'tags') empty[at] = 'made-up value no rule names';
      }
      full.kinds ??= [];
      const result = filterRecords({ records: [full, empty], fields: reads, tree });
      assert.deepEqual(result.incomplete, [], `${recipe.id} "${item.label}" has no unfinished rule`);
      assert.deepEqual(result.matches, [0], `${recipe.id} "${item.label}" keeps the part that meets it and only that one`);
    }
  }
});

test('the trunk carries one daily wake, chooses from every workflow, heals into workflow rows and passes the run-wide agents override', async () => {
  const recipe = byId.get('workflow:grow-the-one-tree');
  // Its own wake is the daily one; every other is a wake its conditions make (read-data/derived-records.mjs).
  const { chosenWakesOf } = await import('../read-data/derived-records.mjs');
  const made = new Set(chosenWakesOf(recipe).map(wake => wake.id));
  assert.deepEqual(recipe.wakes.filter(wake => !made.has(wake.id)).map(wake => [wake.id, wake.input.start_at]), [['daily', 'learn-and-prune']]);
  const stepOf = id => recipe.steps.find(step => step.id === id);
  assert.match(stepOf('choose-branches').do, /tool:choose-the-workflows-that-fire/);
  assert.match(stepOf('choose-branches').do, /tool:filter-rows-by-rules/);
  assert.match(stepOf('fan-out').do, /agents_per_step/);
  assert.match(stepOf('fan-out').do, /new workflow row/);
  assert.doesNotMatch(JSON.stringify(recipe), /tree-branch/, 'no step reads a list of branches');
  assert.match(stepOf('plant-the-seed').do, /cause/);
  assert.ok(!recipe.input_schema.required.includes('seed'), 'a woken run takes its seeds from its cause');
});

test('a broad condition the trunk reports is written as a row the rewrite workflow follows, and only a Waiting row starts it', async () => {
  const trunk = byId.get('workflow:grow-the-one-tree');
  const rewrite = byId.get('workflow:rewrite-a-broad-condition');
  assert.ok(rewrite, 'workflow:rewrite-a-broad-condition is published');
  assert.deepEqual(recipeProblems(rewrite), []);
  // The rewrite follows an added broad_condition row through its own condition (route-each-row-change tells it), and starts
  // with the input that condition names.
  const condition = rewrite.fires_when.find(item => item.condition.fields.some(field => field.id === 'place'));
  const valuesOf = id => condition.condition.tree.rules.find(rule => rule.field === id).params.values;
  const choose = trunk.steps.find(step => step.id === 'choose-branches').do;
  // The trunk writes rows of the kind whose table the condition follows (the kind with - as _), and the arrival source the
  // condition starts it with.
  assert.deepEqual([valuesOf('place'), valuesOf('change')], [['broad_condition'], ['added']]);
  assert.match(choose, new RegExp(`type record:${valuesOf('place')[0].replaceAll('_', '-')}\\b`));
  assert.ok(choose.includes(condition.input.arrival_source), 'choose-branches writes the arrival source the condition names');
  assert.equal(condition.input.start_at, rewrite.steps[0].id);
  // The source row choose-branches writes keeps a Waiting row and drops a Done one, so marking a row Done starts nothing.
  const { initSync, filterRecords } = await import('../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js');
  initSync({ module: (await import('node:fs')).readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
  const { fields, tree } = JSON.parse(choose.match(/filter: the text (\{.*?\}\}\]\}\}), seed/)[1]);
  const result = filterRecords({ records: [{ status: 'Waiting' }, { status: 'Done' }], fields, tree });
  assert.deepEqual(result.incomplete, []);
  assert.deepEqual(result.matches, [0]);
  assert.match(trunk.steps.find(step => step.id === 'learn-and-prune').do, /record:calendar-task:one-tree-overrides-YEAR-MONTH-DAY/);
});
