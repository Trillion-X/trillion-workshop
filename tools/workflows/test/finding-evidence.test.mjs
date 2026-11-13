// tools/workflows: a step row can declare, as data, the fields each finding of its answer must carry (`fields-present`) and
// the values a field may hold (`field-in`); the submit refuses an answer whose findings lack them and names them. Every
// recipe and field name here is made up: no step and no field is known to the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkResults } from '../read-data/recipe-check-results.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';

const REQUIRED = ['pain', 'since_then', 'now', 'proof'];
const checks = [
  { kind: 'fields-present', path: ['this', 'items', '*', 'findings', '*'], fields: REQUIRED, says: 'Each finding says the pain, what was done since, where it stands now and the proof' },
  { kind: 'field-in', path: ['this', 'items', '*', 'findings', '*'], field: 'proof_kind', values: ['measured', 'read'], says: 'The proof is a current measurement or a read of the code' },
];
const step = { id: 'look', title: 'Look', do: 'Look.', submit: { type: 'object' }, checks };
const finding = (id, extra = {}) => ({ id, pain: 'a complaint', since_then: 'commit abc fixed it', now: 'works', proof: 'src/x.rs:10', proof_kind: 'read', ...extra });
const answerOf = findings => ({ items: [{ name: 'one', findings }] });
const run = 'ai-job:workflow:made-up:k1';

function door() {
  const held = new Map([[run, { id: run, value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up', label: 'Made up', job: [step], input: {} } }]]);
  return { held, read: async (_kind, id) => held.get(id)?.value ?? null, async *list() {}, write: async records => { for (const record of records) held.set(record.id, record); } };
}
const submit = (d, findings, key = 's1') => submitARecipeStep({ input: { run, step: 'look', answer: answerOf(findings) }, task: { request_key: key } }, { door: d });

test('the two kinds are valid in a recipe, and a recipe that leaves out their fields is refused', () => {
  const recipe = checks_ => ({ kind: 'workflow-recipe', id: 'workflow:made-up', label: 'Made up', job: 'Made up.', steps: [{ ...step, checks: checks_ }] });
  assert.deepEqual(recipeProblems(recipe(checks)), []);
  assert.match(recipeProblems(recipe([{ kind: 'fields-present', path: ['this', 'items'], says: 'x' }])).join('\n'), /fields/);
  assert.match(recipeProblems(recipe([{ kind: 'field-in', path: ['this', 'items'], field: 'a', says: 'x' }])).join('\n'), /values/);
});

test('a finding with every field and a proof kind passes; a missing, blank, null or empty field is named', () => {
  const judge = findings => checkResults(step, { this: answerOf(findings), input: {}, steps: {} }).map(result => result.failing);
  assert.deepEqual(judge([finding('f1')]), [[], []]);
  assert.deepEqual(judge([finding('f1', { since_then: undefined })])[0], ['f1.since_then']);
  assert.deepEqual(judge([finding('f1', { since_then: '   ' })])[0], ['f1.since_then']);
  assert.deepEqual(judge([finding('f1', { now: null }), finding('f2', { proof: [] })])[0], ['f1.now', 'f2.proof']);
  assert.deepEqual(judge([finding('f1', { proof_kind: 'i think so' })])[1], ['f1.proof_kind']);
});

test('the submit refuses a stale finding without its work done since, naming it, and keeps one that has it', async () => {
  const d = door();
  const stale = finding('f1');
  delete stale.since_then;
  await assert.rejects(submit(d, [stale]), /f1\.since_then/);
  assert.equal(d.held.has(`${run}#answer:look`), false);
  assert.equal((await submit(d, [finding('f1')], 's2')).status, 'kept');
});

test('a finding without a proof kind in the allowed values is refused', async () => {
  await assert.rejects(submit(door(), [finding('f1', { proof_kind: 'remembered' })]), /f1\.proof_kind/);
});
