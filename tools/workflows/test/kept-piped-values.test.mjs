// tools/workflows: a binding that pipes the run's own input or a step's value into a coalesce of defaults only is refused
// with words that name it and the two ways to keep the value; every other shape of piped coalesce found in the rows passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { droppedPipeProblems } from '../read-data/kept-piped-values.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { recipeProblems as writtenProblems } from '../../write-a-job-done-in-several-steps-have/read-data/workflows.mjs';

const shapes = JSON.parse(readFileSync(new URL('./fixtures/piped-coalesce-shapes.json', import.meta.url), 'utf8'));
const definitionWith = binding => ({ steps: [{ id: 'build', kind: 'ask', config: { name: 'tool:make-it', input: { value: binding } } }], edges: [] });

test('each of the 5 bindings that dropped their run input is refused, naming its step, its value and if_null', () => {
  assert.equal(shapes.dropped.length, 5);
  for (const { recipe, binding } of shapes.dropped) {
    const problems = droppedPipeProblems(definitionWith(binding));
    assert.equal(problems.length, 1, recipe);
    assert.match(problems[0], new RegExp(`^definition\\.steps\\.build: the binding selects input\\.${binding.select.path} `));
    assert.match(problems[0], /op:core\.if_null/);
    assert.match(problems[0], /"from": "self"/);
  }
});

test('every other piped-coalesce shape the rows held passes: placeholders, self first, the same selection first, item fallbacks, chosen sub-paths', () => {
  assert.ok(shapes.kept.length >= 50);
  assert.equal(shapes.kept.reduce((sum, shape) => sum + shape.uses, 0), 2737);
  for (const { recipe, binding } of shapes.kept) assert.deepEqual(droppedPipeProblems(definitionWith(binding)), [], recipe);
});

test('the fixed form of each dropped binding passes, and so does if_null', () => {
  for (const { binding } of shapes.dropped) {
    const [coalesce] = binding.transform;
    const selfFirst = { ...binding, transform: [{ ...coalesce, args: { values: [{ $kind: 'binding', select: { from: 'self' } }, ...coalesce.args.values] } }] };
    const ifNull = { ...binding, transform: [{ op: 'op:core.if_null', args: { fallback: coalesce.args.values[0] } }] };
    assert.deepEqual(droppedPipeProblems(definitionWith(selfFirst)), []);
    assert.deepEqual(droppedPipeProblems(definitionWith(ifNull)), []);
  }
});

test('both recipe validators refuse a written definition that drops a piped input', () => {
  const [{ binding }] = shapes.dropped;
  const recipe = {
    id: 'workflow:drop-a-piped-input', label: 'Drop a piped input',
    definition: { steps: [{ id: 'ask', kind: 'ask', config: { name: 'tool:make-it', input: { value: binding } } }], edges: [] },
  };
  for (const problems of [recipeProblems(recipe), writtenProblems(recipe)]) {
    assert.ok(problems.some(problem => /pipes it into op:core\.coalesce whose values are only defaults/.test(problem)), problems.join('\n'));
  }
});
