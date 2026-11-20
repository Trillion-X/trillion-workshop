// test/said-done-steps.test.mjs
//
// The said-done weigh split into the steps a workflow runs (src/said-done.mjs saidDoneAsks, saidDoneVerdict): the question
// for each row, then what one answer means. Each step is pure, so a workflow step can run it with the answer the ask step
// gave. The same outcomes as test/said-done.test.mjs hold when the steps are chained (the last test).
import assert from 'node:assert/strict';
import test from 'node:test';
import { broughtIn } from '../../notice-what-needs-attention/src/brought-in.mjs';
import { saidDoneAsks, saidDoneSettings, saidDoneVerdict, weighSaidDone } from '../src/said-done.mjs';

const list = { id: 'chores', label: 'Chores', row_type: 'chores', title_field: 'what', fields: [
  { id: 'what', kind: 'text' }, { id: 'done_when', kind: 'text' }, { id: 'closed_because', kind: 'text' },
  { id: 'finish', kind: 'choice', choices: ['Tap done', 'Tell the AIs'] },
  { id: 'status', kind: 'choice', choices: ['Waiting', 'Done'], settles: ['Done'], starts: 'Waiting' },
] };
const rowId = 'record:chores:plugin';
const now = new Date().toISOString();
const message = (text, extra = {}) => ({ id: 'message:1', app: 'Claude Code', conversation_id: 'c-1', speaker: 'person', text, at: now, recorded_at: now,
  about: [{ kind: 'record', id: rowId, via: 'entity-ingest' }], ...extra });
const row = { record_id: rowId, row_id: 'plugin', list, field: list.fields[4], values: { what: 'Upload the plugin', done_when: 'The plugin is listed in the store', status: 'Waiting' }, mention: null };
const names = { finish: 'Tell the AIs' };

test('no question is made for AI words, someone else\'s words, or history brought in; a missing finish name is refused', () => {
  assert.deepEqual(saidDoneAsks({ message: message('I did it', { speaker: 'ai' }), rows: [row], names, broughtIn }), []);
  assert.deepEqual(saidDoneAsks({ message: message('I did it', { origin: 'import' }), rows: [row], names, broughtIn }), []);
  assert.deepEqual(saidDoneAsks({ message: message('I did it', { brought_in: true }), rows: [row], names, broughtIn: () => true }), []);
  assert.throws(() => saidDoneAsks({ message: message('x'), rows: [row], names: {}, broughtIn }), /names.finish/);
});

test('the question names the person\'s words, the list and the row, and the settle values fill the list\'s own fields', () => {
  const [ask] = saidDoneAsks({ message: message('I uploaded the plugin already'), rows: [row], names, broughtIn });
  assert.equal(ask.record_id, rowId);
  assert.match(ask.question.state, /I uploaded the plugin already/);
  assert.match(ask.question.state, /Upload the plugin/);
  assert.match(ask.question.state, /listed in the store/, 'the done-when rule is in the question');
  assert.equal(ask.values.status, 'Done', 'the settling field is set to its settled value');
  assert.equal(ask.values.finish, 'Tell the AIs');
});

test('a clear yes settles the row; the boundary is 0.7 exactly', () => {
  const [ask] = saidDoneAsks({ message: message('done'), rows: [row], names, broughtIn });
  const yes = saidDoneVerdict({ ask, probability: 0.92, message: message('done') });
  assert.equal(yes.verdict, 'done');
  assert.deepEqual(yes.settle, { list_id: 'chores', row_id: 'plugin', values: ask.values });
  assert.equal(saidDoneVerdict({ ask, probability: saidDoneSettings.close_at, message: message('done') }).verdict, 'done');
});

test('a clear no does nothing; between the thresholds (0.35 up to 0.7) is handed to the AIs, once per message and row', () => {
  const [ask] = saidDoneAsks({ message: message('how do I upload it?'), rows: [row], names, broughtIn });
  const no = saidDoneVerdict({ ask, probability: 0.05, message: message('x') });
  assert.deepEqual(no, { verdict: 'not_said', probability: 0.05 }, 'no settle, no hand off');
  const unsure = saidDoneVerdict({ ask, probability: saidDoneSettings.unsure_from, message: message('x') });
  assert.equal(unsure.verdict, 'unsure');
  assert.equal(unsure.hand.once_per, `said-done:message:1:${rowId}`);
  assert.equal(unsure.hand.from_agent, 'said-done');
  assert.match(unsure.hand.job, /Upload the plugin/);
  assert.equal(unsure.settle, undefined, 'an unsure answer never settles the row');
});

test('no answer from any computer hands the judgement to the AIs with the silent reason', () => {
  const [ask] = saidDoneAsks({ message: message('x'), rows: [row], names, broughtIn });
  const silent = saidDoneVerdict({ ask, probability: null, message: message('x') });
  assert.equal(silent.verdict, 'no_classifier');
  assert.equal(silent.probability, undefined);
  assert.match(silent.hand.job, new RegExp(saidDoneSettings.why.silent));
});

test('the chained steps give the same outcome as weighSaidDone', async () => {
  const records = { [rowId]: row.values };
  const io = { read: id => records[id] ?? null, listFor: () => list, broughtIn, names, ask: async () => 0.9,
    settle: async () => ({ kept: [] }), handOff: async () => ({ handoff: { handoff_id: 'h_1' } }) };
  const whole = await weighSaidDone({ message: message('I did it'), ...io });
  assert.deepEqual(whole.weighed, [{ record_id: rowId, verdict: 'done', probability: 0.9 }]);
});
