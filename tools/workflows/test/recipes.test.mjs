// tools/workflows: every shipped recipe row passes the recipe validator, and the validator refuses what would make a run fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const recipesFolder = new URL('../recipes/', import.meta.url);
const files = readdirSync(recipesFolder).filter(name => name.endsWith('.json')).sort();

test('the recipes folder holds recipes', () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  test(`every row in ${file} is a valid recipe`, () => {
    const { records } = JSON.parse(readFileSync(new URL(file, recipesFolder), 'utf8'));
    assert.ok(Array.isArray(records) && records.length > 0, `${file} has records`);
    for (const record of records) assert.deepEqual(recipeProblems(record.payload), [], `${file}: ${record.id}`);
  });
}

const step = id => ({ id, title: id, do: `Do ${id}.`, submit: { type: 'object' } });
const recipe = steps => ({ kind: 'workflow-recipe', id: 'workflow:fixture', job: 'Get the fixture done.', steps });

test('a well-formed recipe has no problems', () => {
  assert.deepEqual(recipeProblems(recipe([step('first'), step('second')])), []);
});

test('a step with no `do` is refused', () => {
  const { do: _omitted, ...bare } = step('first');
  assert.deepEqual(recipeProblems(recipe([bare])), ['steps[0].do must say what to do in this step.']);
});

test('a duplicate step id is refused', () => {
  assert.deepEqual(recipeProblems(recipe([step('first'), step('first')])), ['steps[1].id "first" is used twice.']);
});

test('a check that reads a later step is refused', () => {
  const early = { ...step('first'), checks: [{ kind: 'exists', says: 'The tool exists.', path: ['steps', 'second', 'name'], catalog: 'tool' }] };
  assert.deepEqual(recipeProblems(recipe([early, step('second')])), ['steps[0].checks[0].path reads step "second", which is not an earlier step.']);
});

test('a bad id and a missing job are both reported at once', () => {
  assert.equal(recipeProblems({ ...recipe([step('first')]), id: 'Workflow:Bad', job: '' }).length, 2);
});
