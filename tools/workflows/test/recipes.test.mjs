// tools/workflows: every shipped recipe row passes the recipe validator, and the validator refuses what would make a run fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { recipeProblems, CHECK_VOCABULARY } from '../read-data/recipe-problems.mjs';

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

test('a check that reads a field no schema declares is refused, and one the schema leaves open is not', () => {
  const declared = { type: 'object', properties: { picks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } };
  const first = { ...step('first'), submit: declared };
  const reads = path => ({ ...step('second'), checks: [{ kind: 'distinct-at-least', says: 'Enough.', path, count: 1 }] });
  assert.deepEqual(recipeProblems(recipe([first, reads(['steps', 'first', 'picks', '*', 'id'])])), []);
  assert.deepEqual(recipeProblems(recipe([first, reads(['steps', 'first', 'picks', '*', 'name'])])), ['steps[1].checks[0].path reads "name", which step "first" does not declare.']);
  assert.deepEqual(recipeProblems(recipe([first, reads(['this', 'anything'])])), []);
  const open = { ...step('first'), submit: { type: 'object', properties: {}, additionalProperties: { type: 'string' } } };
  assert.deepEqual(recipeProblems(recipe([open, reads(['steps', 'first', 'anything'])])), []);
  assert.deepEqual(recipeProblems({ ...recipe([reads(['input', 'missing'])]), input_schema: { type: 'object', properties: { goal: { type: 'string' } } } }), ['steps[0].checks[0].path reads "missing", which the input does not declare.']);
});

test('a bad id and a missing job are both reported at once', () => {
  assert.equal(recipeProblems({ ...recipe([step('first')]), id: 'Workflow:Bad', job: '' }).length, 2);
});

test('a check kind added only as a DATA row is accepted, and refused without the row', () => {
  const row = {
    kind: 'starts-with',
    meaning: 'The text at path begins with one of the listed words.',
    fields: [
      { field: 'path', shape: 'path', required: true, refusal: 'is required.' },
      { field: 'words', shape: 'words', required: true, refusal: 'must list the words it may begin with.' },
    ],
  };
  const withRow = { ...CHECK_VOCABULARY, kinds: [...CHECK_VOCABULARY.kinds, row] };
  const check = { kind: 'starts-with', says: 'It opens with a greeting.', path: ['this', 'text'], words: ['hello'] };
  const checked = recipe([{ ...step('first'), checks: [check] }]);
  assert.deepEqual(recipeProblems(checked, withRow), []);
  assert.match(recipeProblems(checked)[0], /kind must be one of: subset-of, covers/);
  assert.deepEqual(recipeProblems(recipe([{ ...step('first'), checks: [{ ...check, words: [] }] }]), withRow), ['steps[0].checks[0].words must list the words it may begin with.']);
});

test('the shipped vocabulary refuses a missing field, a bad count and an unknown catalog from its rows', () => {
  const bad = checks => recipeProblems(recipe([{ ...step('first'), checks }]));
  assert.deepEqual(bad([{ kind: 'covers', says: 'x', path: ['input', 'a'] }]), ['steps[0].checks[0] needs of or values.']);
  assert.deepEqual(bad([{ kind: 'distinct-at-least', says: 'x', path: ['input', 'a'], count: 0 }]), ['steps[0].checks[0].count must be a whole number above 0.']);
  assert.deepEqual(bad([{ kind: 'exists', says: 'x', path: ['input', 'a'], catalog: 'nope' }]), ['steps[0].checks[0].catalog must be one of: workflow, tool, list-row, record.']);
});
