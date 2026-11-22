// A row is refused when a start it has cannot give a run-input key one of its steps reads. Stub rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unresolvedInputBindings as found } from '../read-data/input-bindings.mjs';

const unresolvedInputBindings = row => found(row).map(({ line }) => line);
import { planRender } from '../read-data/render.mjs';

const fromInput = path => ({ $kind: 'binding', select: { from: 'input', path } });
const sqlStep = (id, credential) => ({ id, kind: 'ask', config: { name: 'tool:run-sql-in-my-database', input: { credential_name: credential, sql: 'select 1' } } });
const chosen = (id, input) => ({ id, on: { fact: { from: ['run'], kind: 'workflow-chosen' } }, input });
const due = (id, input) => ({ id, on: { fact: { from: ['run'], kind: 'due-time' } }, input });
const row = (fields) => ({ recipe: 'workflow:keep-a-thing', definition: { steps: [sqlStep('keep', fromInput('fact.where'))] }, wakes: [], fires_when: null, ...fields });
const rule = (fields = {}) => ({ label: 'a thing was added', state: 'On', condition: { tree: { kind: 'group', rules: [] } }, ...fields });

test('a router-started run that reads its store from fact.where passes', () => {
  assert.deepEqual(unresolvedInputBindings(row({ wakes: [chosen('chosen--a-thing', null)] })), []);
});

test('a router-started run that reads store.credential_name is refused, naming the recipe, step, path and wake', () => {
  const problems = unresolvedInputBindings(row({ definition: { steps: [sqlStep('keep', fromInput('store.credential_name'))] }, wakes: [chosen('chosen--a-thing', null)] }));
  assert.deepEqual(problems, ['workflow:keep-a-thing step keep reads input.store.credential_name, which wake chosen--a-thing (workflow-chosen) does not give']);
});

test('a due-time run that reads a key its wake input carries passes', () => {
  const steps = [sqlStep('keep', fromInput('credential_name'))];
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps }, wakes: [due('hourly', { credential_name: 'a-store', start_at: 'keep' })] })), []);
});

test('a due-time run that reads fact.* is refused: a time is no fact the run reads', () => {
  const problems = unresolvedInputBindings(row({ wakes: [due('hourly', { start_at: 'keep' })] }));
  assert.deepEqual(problems, ['workflow:keep-a-thing step keep reads input.fact.where, which wake hourly (due-time) does not give']);
});

test('a row with a time wake and a fires_when rule is judged at each start', () => {
  const steps = [sqlStep('keep', fromInput('fact.where')), sqlStep('count', fromInput('credential_name'))];
  const problems = unresolvedInputBindings(row({ definition: { steps }, wakes: [due('hourly', { credential_name: 'a-store' })], fires_when: [rule()] }));
  assert.deepEqual(problems, [
    'workflow:keep-a-thing step keep reads input.fact.where, which wake hourly (due-time) does not give',
    'workflow:keep-a-thing step count reads input.credential_name, which fires_when "a thing was added" (workflow-chosen) does not give',
  ]);
});

test('a fires_when rule gives its own input, and an Off rule starts nothing', () => {
  const steps = [sqlStep('keep', fromInput('store.credential_name'))];
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps }, fires_when: [rule({ input: { store: { credential_name: 'a-store' } } })] })), []);
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps }, fires_when: [rule({ state: 'Off' })] })), []);
});

test('a nested sub-path is judged by its first key: any fact.* passes a router start, a missing first key is refused', () => {
  const steps = [{ id: 'note', kind: 'ask', config: { name: 'tool:keep-a-note', input: { about: { place: fromInput('fact.payload.row.place'), who: { name: fromInput('person.name.first') } } } } }];
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps }, wakes: [chosen('chosen--a-thing', null)] })), [
    'workflow:keep-a-thing step note reads input.person.name.first, which wake chosen--a-thing (workflow-chosen) does not give',
  ]);
});

test('a coalesce passes when any of its values resolves, and is refused naming every input path when none does', () => {
  const coalesce = (...values) => ({ $kind: 'binding', select: { from: 'literal', value: null }, transform: [{ op: 'op:core.coalesce', args: { values } }] });
  const wakes = [chosen('chosen--a-thing', null)];
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps: [sqlStep('keep', coalesce(fromInput('store.credential_name'), fromInput('fact.where')))] }, wakes })), []);
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps: [sqlStep('keep', coalesce(fromInput('store.credential_name'), fromInput('database')))] }, wakes })), [
    'workflow:keep-a-thing step keep reads input.store.credential_name, which wake chosen--a-thing (workflow-chosen) does not give',
    'workflow:keep-a-thing step keep reads input.database, which wake chosen--a-thing (workflow-chosen) does not give',
  ]);
});

test('omit_if_missing, the whole input, a values path, edges, and a row with no start are not refused', () => {
  const wakes = [due('hourly', {})];
  const optional = { ...fromInput('store'), omit_if_missing: true };
  const whole = fromInput('');
  const values = { $kind: 'binding', values: ['input', 'items', '*', 'url'], take: 'all' };
  const steps = [{ id: 'keep', kind: 'ask', config: { name: 'tool:keep-a-note', input: { optional, whole } } }];
  const edges = [{ from: 'keep', to: 'done', kind: 'on_result', config: fromInput('output.held') }];
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps, edges }, wakes })), []);
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps: [{ id: 'list', kind: 'ask', config: { input: { items: values } } }] }, wakes })), [
    'workflow:keep-a-thing step list reads input.items.*.url, which wake hourly (due-time) does not give',
  ]);
  assert.deepEqual(unresolvedInputBindings(row({ definition: { steps: [sqlStep('keep', fromInput('store.credential_name'))] } })), []);
});

test('another fact that wakes a run gives fact and fact_id', () => {
  const wakes = [{ id: 'a-tool-ran', on: { fact: { from: ['run'], kind: 'tool-ran' } }, input: null }];
  assert.deepEqual(unresolvedInputBindings(row({ wakes })), []);
});

const unfixed = (flags) => ({
  recipe: 'workflow:keep-a-thing', title: 'Keep a thing', job: 'Keeps a thing.', produces: 'A kept thing.', input_schema: { type: 'object' },
  kept_at: '2026-11-22T12:00:00Z', source: {}, records: null, fires_when: [rule()], flags,
  definition: { steps: [sqlStep('keep', fromInput('store.credential_name'))], edges: [] }, wakes: [],
});
const line = 'workflow:keep-a-thing step keep reads input.store.credential_name, which fires_when "a thing was added" (workflow-chosen) does not give';

test('planRender reports an unresolved binding as a finding and still plans the file', () => {
  const plan = planRender(unfixed(['public']));
  assert.deepEqual(plan.findings, [`FINDING: ${line}`]);
  assert.ok(!plan.problems.some(problem => problem.includes('reads input.')));
  assert.ok(plan.recipe);
});

test('a row its owner marked inputs-checked refuses it, with the flags as a list or an object', () => {
  for (const flags of [['public', 'inputs-checked'], { 'inputs-checked': true }]) {
    const plan = planRender(unfixed(flags));
    assert.ok(plan.problems.includes(`REFUSED: ${line}`));
    assert.deepEqual(plan.findings, []);
  }
});

test('a key the row declares in its input_schema is a lower-grade finding, never refused', () => {
  const row = { ...unfixed(['inputs-checked']), definition: { steps: [sqlStep('act', fromInput('answer_to'))], edges: [] },
    wakes: [{ id: 'asked-from-an-app', on: { fact: { from: ['run'], kind: 'asked-from-an-app' } }, input: null }], fires_when: null,
    input_schema: { type: 'object', properties: { answer_to: { type: 'string' } } } };
  assert.deepEqual(found(row), [{ declared: true, line: 'workflow:keep-a-thing step act reads input.answer_to, which wake asked-from-an-app (asked-from-an-app) does not give, which its input_schema declares (a dispatcher may give it)' }]);
  const plan = planRender(row);
  assert.ok(!plan.problems.some(problem => problem.includes('reads input.')));
  assert.equal(plan.findings.length, 1);
});
