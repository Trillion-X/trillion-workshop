// tools/workflows: a recipe is read back from the rows of a list, recipes/workflows.json is exactly what the two
// published view files make, and a recipe that names a tool nothing offers is reported as a gap, not refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeFromRows, recipesFromViews } from '../read-data/recipe-rows.mjs';
import { rebuiltRecipesText } from '../do-work/rebuild-recipes.mjs';
import { recipeProblems, recipeToolGaps, recipeToolIds, HOST_TOOLS } from '../read-data/recipe-problems.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

// What a mapping makes of a recipe: flat values, nested parts as JSON text. Written here only to prove the way back.
const json = value => (value === undefined ? undefined : JSON.stringify(value));
const recipeRow = (slug, recipe) => ({ id: slug, values: { title: recipe.label, recipe: recipe.id, job: recipe.job, produces: recipe.produces, made_from: recipe.made_from, input_schema: json(recipe.input_schema), source: json(recipe.source), wakes: json(recipe.wakes), flags: ['public'] } });
const stepRows = (slug, recipe) => recipe.steps.map((step, at) => ({ id: `${slug}--${step.id}`, values: { title: step.title, recipe: [slug], position: at + 1, step: step.id, do: step.do, submit: json(step.submit), checks: json(step.checks?.length ? step.checks : undefined), run_tool: json(step.run_tool), actor_policy: json(step.actor_policy), flags: ['public'] } }));

const bakery = {
  kind: 'workflow-recipe', id: 'workflow:bake-the-morning-batch', label: 'Bake the morning batch', job: 'Get the morning batch of loaves baked and counted.',
  produces: 'A count of loaves per kind.', made_from: ['workflow:count-the-shelves'],
  input_schema: { type: 'object', properties: { loaves: { type: 'integer' } } }, source: { from: 'a baker' },
  steps: [
    { id: 'mix', title: 'Mix', do: 'Mix the dough with tool:weigh-flour.', submit: { type: 'object', properties: { dough: { type: 'string' } } } },
    { id: 'count', title: 'Count', do: 'Count the loaves.', submit: { type: 'object', properties: { loaves: { type: 'integer' } } }, checks: [{ kind: 'distinct-at-least', says: 'At least one kind', path: ['this', 'kinds'], count: 1 }], run_tool: { tool_id: 'tool:tell-the-person', input: {} } },
  ],
};

test('a recipe is read back from its row and its step rows, whatever order the steps come in', () => {
  const rows = stepRows('bake-the-morning-batch', bakery);
  assert.deepEqual(recipeFromRows(recipeRow('bake-the-morning-batch', bakery), [rows[1], rows[0]]), bakery);
});

test('rows of the door, which hold `value`, are read the same as rows of a published file, which hold `values`', () => {
  const rows = stepRows('bake-the-morning-batch', bakery).map(({ id, values }) => ({ id, value: values }));
  const row = recipeRow('bake-the-morning-batch', bakery);
  assert.deepEqual(recipeFromRows({ id: row.id, value: row.values }, rows), bakery);
});

test('two views make every recipe, ordered by id, and refuse steps that link to no recipe, a recipe with no steps and text that is not JSON', () => {
  const other = { ...bakery, id: 'workflow:another-one', label: 'Another one' };
  const workflows = { rows: [recipeRow('bake-the-morning-batch', bakery), recipeRow('another-one', other)] };
  const steps = { rows: [...stepRows('bake-the-morning-batch', bakery), ...stepRows('another-one', other)] };
  assert.deepEqual(recipesFromViews(workflows, steps).map(recipe => recipe.id), ['workflow:another-one', 'workflow:bake-the-morning-batch']);
  assert.throws(() => recipesFromViews({ rows: [recipeRow('another-one', other)] }, steps), /does not hold/);
  assert.throws(() => recipesFromViews(workflows, { rows: stepRows('another-one', other) }), /has no steps/);
  const broken = stepRows('another-one', other);
  broken[0].values.submit = '{not json';
  assert.throws(() => recipesFromViews({ rows: [recipeRow('another-one', other)] }, { rows: broken }), /not JSON/);
});

test('recipes/workflows.json is exactly what the two published view files make, and every recipe in it is valid', () => {
  assert.equal(read('../recipes/workflows.json'), rebuiltRecipesText());
  for (const { payload } of JSON.parse(read('../recipes/workflows.json')).records) assert.deepEqual(recipeProblems(payload), [], payload.id);
});

test('a tool the Workshop offers is no gap, a host tool is no gap, and a tool nothing offers is one', () => {
  const recipe = { steps: [
    { id: 'a', do: 'Weigh with tool:weigh-flour, then say so with tool:tell-the-person, then bake with tool:use-the-oven.', submit: { type: 'object' }, run_tool: { tool_id: 'tool:measure-heat', input: {} } },
  ] };
  assert.deepEqual(recipeToolIds(recipe), ['tool:measure-heat', 'tool:tell-the-person', 'tool:use-the-oven', 'tool:weigh-flour']);
  assert.ok(HOST_TOOLS.has('tool:tell-the-person'));
  const known = new Set(['tool:weigh-flour', 'tool:measure-heat']);
  assert.deepEqual(recipeToolGaps(recipe, { known }), ['tool:use-the-oven']);
  assert.deepEqual(recipeProblems({ id: 'workflow:fixture', job: 'Bake.', ...recipe }), [], 'a gap is a warning: the recipe is still valid');
});

test('an id that has a colon in it, such as a tool taken from a repository, is one id, and a full stop after an id is not part of it', () => {
  assert.deepEqual(recipeToolIds({ steps: [{ do: 'Run tool:github:some-owner-some-repo. Then tool:weigh-flour.' }] }), ['tool:github:some-owner-some-repo', 'tool:weigh-flour']);
});
