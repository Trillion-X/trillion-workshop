// An on_result edge must branch on a boolean: its binding ends in a boolean transform, or the source SQL aliases the column as a boolean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const recipe = (edge, sql = 'SELECT 1 AS ok') => ({
  id: 'workflow:edge-check', job: 'Check one edge.',
  definition: {
    steps: [
      { id: 'look', kind: 'ask', config: { name: 'tool:run-sql-in-my-database', input: { sql } } },
      { id: 'yes', kind: 'return', config: { value: 'yes' } },
    ],
    edges: [{ from: 'look', to: 'yes', kind: 'on_result', config: edge }],
  },
});
const onRead = (path, transform) => ({ $kind: 'binding', select: { from: 'input', path }, ...(transform ? { transform } : {}) });
const isBoolOp = { op: 'op:core.equals', args: { value: true } };

test('an on_result edge that ends in a boolean transform passes', () => {
  assert.deepEqual(recipeProblems(recipe(onRead('output.rows.0.ok', [isBoolOp]))).filter(p => p.includes('boolean')), []);
});

test('an on_result edge that reads text, a count or null is refused', () => {
  assert.match(recipeProblems(recipe(onRead('output.rows.0.ok'))).join('\n'), /without a boolean transform \(ends with no transform\)/);
  assert.match(recipeProblems(recipe(onRead('output.rows.0.n', [{ op: 'op:core.array_length' }]))).join('\n'), /ends with op:core.array_length/);
});

test('an on_result edge is allowed when the source SQL aliases the column as a boolean expression', () => {
  const sql = 'SELECT (count(*) > 0) AS ok FROM t';
  assert.deepEqual(recipeProblems(recipe(onRead('output.rows.0.ok'), sql)).filter(p => p.includes('boolean')), []);
});
