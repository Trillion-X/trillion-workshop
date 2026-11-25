// The rights a workflow row holds and the wakes of its conditions are made from the rest of the row
// (read-data/derived-records.mjs): every shipped recipe holds exactly what it makes, so neither is written by hand.
import assert from 'node:assert/strict';
import test from 'node:test';
import { recordsOf, chosenWakesOf, withDerivedRecords } from '../read-data/derived-records.mjs';
import { RUN_ACTOR } from '../../write-a-job-done-in-several-steps-have/read-data/workflows.mjs';

test('a row runs the tools its steps ask and tells only a fact kind a step names as a value', () => {
  const step = (id, name, input = {}) => ({ id, kind: 'ask', config: { name, input, context: { step_id: id } } });
  const recipe = { id: 'workflow:made-up', label: 'Made up', definition: { id: 'workflow:made-up', version: 1, edges: [], steps: [
    step('a', 'tool:made-up-b'), step('b', 'tool:made-up-a'), step('c', 'tool:made-up-a'), step('d', RUN_ACTOR),
    step('e', 'wake:arrive', { kind: 'made-up-fact', event_id: 'x', payload: {} }),
    step('f', 'wake:arrive', { kind: { $kind: 'binding', select: { from: 'input', path: 'kind' } } }),
  ] } };
  assert.deepEqual(recordsOf(recipe), { rights: [{ at: '@own-records', id: 'made-up-fact', operations: ['wake:arrive'] }], runs: ['tool:made-up-a', 'tool:made-up-b'] });
  assert.equal(recordsOf({ ...recipe, definition: { ...recipe.definition, steps: [step('d', RUN_ACTOR)] } }), null);
});

test('each condition that is not off gets one wake on the chosen fact, with its own input', () => {
  const recipe = { id: 'workflow:made-up', steps: [{ id: 'first' }], fires_when: [
    { label: 'A row is added', state: 'On', input: { start_at: 'first', why: 'x' } },
    { label: 'Turned off', state: 'Off' },
    { label: 'No input', state: 'On' }] };
  const wakes = chosenWakesOf(recipe);
  assert.deepEqual(wakes.map(wake => [wake.id, wake.on.fact.match, wake.input]), [
    ['chosen--a-row-is-added', { workflow: 'workflow:made-up', condition: 'A row is added' }, { start_at: 'first', why: 'x' }],
    ['chosen--no-input', { workflow: 'workflow:made-up', condition: 'No input' }, { start_at: 'first' }]]);
  const again = withDerivedRecords({ ...recipe, wakes: [{ id: 'kept' }, { id: 'chosen--gone' }] });
  assert.deepEqual(again.wakes.map(wake => wake.id), ['kept', 'chosen--a-row-is-added', 'chosen--no-input']);
});

test('a tools:run step naming a server by its address adds that server\'s tool by the engine\'s key; a list needs no right', () => {
  const step = (id, name, input = {}) => ({ id, kind: 'ask', config: { name, input, context: { step_id: id } } });
  const bind = path => ({ $kind: 'binding', select: { from: 'input', path } });
  const recipe = { id: 'workflow:made-up', label: 'Made up', definition: { id: 'workflow:made-up', version: 1, edges: [], steps: [
    step('list', 'tools:list', { address: 'https://mcp.example.test/mcp', credential: 'made-up-key' }),
    step('run', 'tools:run', { address: 'https://mcp.example.test:8443/mcp', tool: 'search', input: {} }),
    step('own', 'tools:run', { tool: 'tool:made-up-c', input: {} }),
    step('bound', 'tools:run', { address: bind('address'), tool: 'search' }),
    step('local', 'tools:run', { address: 'http://localhost/mcp', tool: 'search' }),
  ] } };
  assert.deepEqual(recordsOf(recipe), { runs: ['mcp.example.test/search', 'tool:made-up-c'] });
});

test('a workflow a fact wakes is given no reader tool: the fact carries the change, and nothing names a store', () => {
  const recipe = { id: 'workflow:made-up', steps: [{ id: 'first', do: 'x' }], fires_when: [{ label: 'A row is added', state: 'On' }] };
  assert.equal(recordsOf(recipe), null);
  assert.equal(recordsOf({ ...recipe, fires_when: [] }), null);
});
