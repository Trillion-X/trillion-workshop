// tools/workflows: recipe checks judged against a step's output. PR #2's `differs-from` check (the sending identity of
// workflow:reach-local-businesses-by-zip-code is not on the main domain) runs from the shipped recipe and fails when
// the step sends from the main domain; every shipped kind has an evaluator; an unknown kind or an `exists` check with
// no catalog is reported as not evaluated, never as passed. Every address is example.*.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CHECK_EVALUATORS, checkResults, valuesAt } from '../read-data/recipe-check-results.mjs';
import { CHECK_VOCABULARY } from '../read-data/recipe-problems.mjs';

const recipes = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(({ payload }) => payload);
const identity = recipes.find(recipe => recipe.id === 'workflow:reach-local-businesses-by-zip-code').steps.find(step => step.id === 'identity');
const tools = { tool: id => id === 'tool:list-email-sending-domains' };
const output = domain => ({ tool: 'tool:list-email-sending-domains', sending_domain: domain, verified: true, separate_from_main: true });
const input = { from: 'hello@send.example.com', main_domain: 'example.com' };
const byKind = (results, kind) => results.find(result => result.kind === kind);

test('the shipped differs-from check passes on a separate sending domain', () => {
  const results = checkResults(identity, { this: output('send.example.com'), input, steps: {} }, { catalogs: tools });
  assert.deepEqual(byKind(results, 'differs-from'), { kind: 'differs-from', says: 'The sending identity is not on the main domain', passed: true, failing: [] });
  assert.ok(results.every(result => result.passed), JSON.stringify(results));
});

test('the shipped differs-from check fails when the step sends from the main domain', () => {
  const results = checkResults(identity, { this: output('example.com'), input: { from: 'hello@example.com', main_domain: 'example.com' }, steps: {} }, { catalogs: tools });
  assert.deepEqual(byKind(results, 'differs-from'), { kind: 'differs-from', says: 'The sending identity is not on the main domain', passed: false, failing: ['example.com'] });
  assert.equal(byKind(results, 'mentioned-in').passed, true);
});

test('every kind in the vocabulary has an evaluator, and every check in every shipped recipe runs', () => {
  assert.deepEqual(CHECK_VOCABULARY.kinds.map(row => row.kind).filter(kind => !CHECK_EVALUATORS[kind]), []);
  for (const recipe of recipes) for (const step of recipe.steps ?? []) {
    for (const result of checkResults(step, { this: {}, input: {}, steps: {} }, { catalogs: { workflow: () => true, tool: () => true, 'list-row': () => true, record: () => true } })) {
      assert.equal(typeof result.passed, 'boolean', `${recipe.id} ${step.id} ${result.kind}`);
    }
  }
});

test('a path walks lists with * and a list it ends on gives its items', () => {
  const context = { this: { kept: [{ tags: ['a', 'b'] }, { tags: ['c'] }] }, input: {}, steps: { find: { ids: ['x', 'y'] } } };
  assert.deepEqual(valuesAt(['this', 'kept', '*', 'tags'], context), ['a', 'b', 'c']);
  assert.deepEqual(valuesAt(['steps', 'find', 'ids'], context), ['x', 'y']);
  assert.deepEqual(valuesAt(['this', 'missing'], context), []);
});

test('each kind fails on the values that break it', () => {
  const context = { this: { picked: ['a', 'z'], words: 'buy now', n: ['a', 'a'] }, input: { offered: ['a', 'b'], note: 'only a here' }, steps: {} };
  const run = check => checkResults({ checks: [{ says: 's', ...check }] }, context)[0];
  assert.deepEqual(run({ kind: 'subset-of', path: ['this', 'picked'], of: ['input', 'offered'] }).failing, ['z']);
  assert.deepEqual(run({ kind: 'covers', path: ['this', 'picked'], of: ['input', 'offered'] }).failing, ['b']);
  assert.deepEqual(run({ kind: 'covers', path: ['this', 'picked'], values: ['a'] }).failing, []);
  assert.deepEqual(run({ kind: 'mentioned-in', path: ['this', 'picked'], in: ['input', 'note'] }).failing, ['z']);
  assert.deepEqual(run({ kind: 'excludes-words', path: ['this', 'words'], words: ['Buy', 'free'] }).failing, ['Buy']);
  assert.equal(run({ kind: 'distinct-at-least', path: ['this', 'n'], count: 2 }).passed, false);
  assert.deepEqual(run({ kind: 'differs-from', path: ['this', 'picked'], of: ['input', 'offered'] }).failing, ['a']);
});

test('an unknown kind, and exists with no catalog, are not evaluated rather than passed', () => {
  const [unknown, exists] = checkResults({ checks: [{ kind: 'rhymes-with', says: 'x', path: ['this'] }, { kind: 'exists', says: 'y', path: ['this', 'tool'], catalog: 'tool' }] }, { this: { tool: 'tool:a' }, input: {}, steps: {} });
  assert.equal(unknown.evaluated, false);
  assert.equal(exists.evaluated, false);
  assert.ok(!('passed' in unknown) && !('passed' in exists));
});
