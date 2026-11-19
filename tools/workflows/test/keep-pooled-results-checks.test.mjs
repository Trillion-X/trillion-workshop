// tools/workflows/test/keep-pooled-results-checks.test.mjs
//
// The checks on a pooled result are the store's own objects (render step of recipes/keep-pooled-results.json), not
// words in the keep step. This proves the recipe carries them: the prove step's last four example attempts are refused
// for a contributor that is not 64 lowercase hex, a worked that is not 0 or 1, and a write with no precondition on its
// shared situation (missing input), and the one allowed contribution is written. Each answer is checked against the
// attempt at the same position. All people here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recipe = JSON.parse(readFileSync(new URL('../recipes/keep-pooled-results.json', import.meta.url), 'utf8'));
const payload = recipe.records[0].payload;
const step = id => payload.steps.find(s => s.id === id);
const prove = step('prove');
const attempts = JSON.parse(prove.do.slice(prove.do.indexOf('objects: [') + 'objects: '.length, prove.do.indexOf('. Answers:')));
const answers = prove.checks.find(check => check.kind === 'covers').values[0];

test('the render step puts the checks on the Postgres table itself, so a plain insert is refused, and says what a JSON folder cannot enforce', () => {
  const render = step('render').do;
  assert.match(render, /CREATE TABLE pooled_result/);
  assert.match(render, /CHECK \(contributor ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(render, /BEFORE INSERT OR UPDATE ON pooled_result/);
  assert.match(render, /a file written by hand bypasses them/);
  assert.match(render, /CHECK constraint in SQL/);
  assert.match(render, /64 lowercase hex/);
  assert.match(render, /not 0 or 1/);
  assert.match(render, /no precondition on its shared situation/);
  assert.match(render, /consent is the store's own check/);
  assert.match(render, /embedding is copied by the object/);
});

test('the keep step writes only through those objects and names no check of its own as words', () => {
  const keep = step('keep').do;
  assert.match(keep, /only through the objects the render step made/);
  assert.doesNotMatch(keep, /must be 64 lowercase hex|else refused/);
});

test('a contribution from the wrong contributor is refused by the store', () => {
  const at = attempts.findIndex(op => op.op === 'batch' && op.writes.some(w => w.value?.contributor === 'NOT-HEX'));
  assert.ok(at >= 0, 'an attempt with a contributor that is not 64 lowercase hex exists');
  assert.equal(answers[at], 'refused');
});

test('a worked that is not true or false is refused by the store', () => {
  const at = attempts.findIndex(op => op.op === 'batch' && op.writes.some(w => w.value?.worked === 2));
  assert.ok(at >= 0, 'an attempt with worked 2 exists');
  assert.equal(answers[at], 'refused');
});

test('a result with no precondition on its shared situation (missing input) is refused by the store', () => {
  const at = attempts.findIndex(op => op.op === 'batch' && op.preconditions.length === 0 && op.writes.some(w => w.value?.contributor));
  assert.ok(at >= 0, 'an attempt with no precondition exists');
  assert.equal(answers[at], 'refused');
});

test('a plain insert straight into the table with a bad contributor is refused by the table itself', () => {
  const at = attempts.findIndex(op => op.op === 'direct insert');
  assert.equal(at, attempts.length - 1, 'the direct insert is the last attempt');
  assert.equal(attempts[at].on, 'postgres');
  assert.match(attempts[at].sql, /NOT-HEX/);
  assert.equal(answers[at], 'refused');
});

test('an allowed contribution, at a shared situation with its version and a valid contributor and bit, is written', () => {
  const at = attempts.length - 2;
  const op = attempts[at];
  assert.equal(op.op, 'batch');
  assert.deepEqual(op.preconditions, [{ address: 'record:pooled-situation:sample-situation-1', expected_version: 1 }]);
  assert.equal(op.writes[0].value.worked, 1);
  assert.equal(answers[at], 'written');
});

test('every example attempt has exactly one answer', () => {
  assert.equal(answers.length, attempts.length);
});
