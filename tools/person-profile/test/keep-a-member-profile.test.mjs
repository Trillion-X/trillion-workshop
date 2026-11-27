// tools/person-profile: the member-profile rows were replaced by workflow:keep-a-member-profile (the person's own store keeps
// the rows). This checks the recipe and its kit are valid, and that no row of this folder names a records method.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recipe = read('../../workflows/recipes/keep-a-member-profile.json').records[0].payload;
const kit = read('../../workflows/kits/keep-a-member-profile.json');
const rows = read('../what-this-tool-does-and-how-to-run-it.json');

test('the member-profile recipe passes the recipe validator and its prove step checks the example attempts', () => {
  assert.deepEqual(recipeProblems(recipe), []);
  const prove = recipe.steps.find(step => step.id === 'prove');
  assert.equal(prove.checks.length, 2);
  assert.equal(prove.checks[0].values[0].length, 7, 'seven attempts, one outcome each');
});

test('the kit names only its recipe, and its worked example gives every input the recipe requires', () => {
  assert.deepEqual(kit.workflows, ['workflow:keep-a-member-profile']);
  for (const required of recipe.input_schema.required) assert.ok(required in kit.worked_examples[0].mcp.input.input.input, `example gives ${required}`);
});

test('no row of this folder names a records method, and the layout row stays', () => {
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /records:(read|write|list|search)\b/);
  assert.deepEqual(rows.records.map(record => record.payload.id), ['tool:lay-out-a-profile']);
});
