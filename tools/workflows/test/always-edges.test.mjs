// An "always" edge takes its next step unconditionally. A config on it would look like a gate and gate nothing, so it is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const recipe = (edge) => ({
  id: 'workflow:always-check', job: 'Check one edge.',
  definition: {
    steps: [
      { id: 'voice', kind: 'return', config: { value: 'ok' } },
      { id: 'publish', kind: 'return', config: { value: 'done' } },
    ],
    edges: [edge],
  },
});

test('a bare always edge passes', () => {
  assert.deepEqual(recipeProblems(recipe({ from: 'voice', to: 'publish', kind: 'always' })).filter(p => p.includes('always edge')), []);
});

test('an always edge with a condition is refused, because the engine ignores the condition', () => {
  const problems = recipeProblems(recipe({ from: 'voice', to: 'publish', kind: 'always', config: { $kind: 'binding', select: { from: 'input', path: 'output.ok' } } })).join('\n');
  assert.match(problems, /definition\.edges\[0\] \(voice -> publish\) is an always edge with a config/);
});
