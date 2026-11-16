import test from 'node:test';
import assert from 'node:assert/strict';
import { readWaitingOnMe, finishWaitingOnMe, verifyWaitingCompletion } from '../read-data/waiting-records.mjs';
import DATA from '../read-data/waiting-sources.json' with { type: 'json' };
import ROWS from '../tool-rows.json' with { type: 'json' };
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const doorOf = (records = [], runs = {}) => ({
  list: async function* ({ type }) { for (const record of records) if (record.type === type) yield record; },
  run: async (tool, input) => { if (!runs[tool]) throw new Error('No reader is installed.'); return runs[tool](input); },
});
const own = (id, value) => ({ id, type: DATA.registry_type, value });

test('current record and reader-tool sources compose once, while unported owners remain unread', async () => {
  const record = { id: 'record:waiting-on-you:sample', type: 'record:waiting-on-you', value: { what: 'Sign the sample form', do_it_in: '/sample/form', status: 'Open', round_step: 'Run a sample tasting', rounds_done: 1, progress: 'One sample tasting recorded' } };
  let decisionReads = 0;
  const post = { id: 'post:sample', type: 'post', value: { post_id: 'post:sample', caption: 'A sample post', status: 'draft', media: { identity: 'sample-file' } } };
  const answer = await readWaitingOnMe({}, { door: doorOf([record, post], {
    'tool:my-notification-devices': () => ({ devices: [{ device_id: 'sample-device', label: 'Sample phone', can_show: 'denied', turn_on: '/sample/settings' }] }),
    'tool:see-my-decisions': () => { decisionReads++; return { summaries: [{ case_id: 'source:sample', goal: 'A sample decision', status: 'needs_decision' }], next_before: null }; },
  }) });
  assert.equal(answer.complete, false);
  const ask = answer.sections.find(section => section.id === 'asks').cards[0];
  assert.equal(ask.id, record.id);
  assert.equal(ask.round_step, record.value.round_step);
  assert.equal(ask.rounds_done, 1);
  assert.equal(ask.progress, record.value.progress);
  assert.equal(answer.sections.find(section => section.id === 'decide').cards[0].id, 'source:sample');
  assert.equal(answer.sections.find(section => section.id === 'turn-on-notices').cards[0].address, '/sample/settings');
  assert.equal(decisionReads, 1, 'decision and outcome sections share the same source read');
  assert.equal(answer.sections.find(section => section.id === 'approve').cards[0].artifact_identity, 'sample-file');
  assert.equal(answer.sections.find(section => section.id === 'approve').cards[0].address, '/use/check-a-post/post:sample');
  assert.equal(answer.sources.find(source => source.id === 'given').unread, true);
  assert.match(answer.said, /not read|unread|could not/i);
});

const waiting = (id, value) => ({ id, type: 'record:waiting-on-you', value });
const apply = (held, write) => held.map(record => write.find(item => item.id === record.id) ?? record).map(({ expected: _expected, ...record }) => record);

test('Done answers the completion as a write for the same ask record, a retry is safe, and another source cannot be guessed done', () => {
  const id = 'record:waiting-on-you:sample';
  const held = [waiting(id, { what: 'Sign the sample form', status: 'Waiting' })];
  const input = { ids: [id], request_key: 'sample-done', records: held };
  const first = finishWaitingOnMe(input);
  assert.deepEqual({ completed: first.completed, changed: first.changed }, { completed: [id], changed: 1 });
  assert.equal(first.write[0].value.status, 'Done', 'the answer holds the result');
  assert.deepEqual(first.write[0].expected, { type: 'record:waiting-on-you', value: held[0].value }, 'the write expects the value that was read');
  assert.equal(held[0].value.status, 'Waiting', 'nothing is changed in what was handed in');
  const kept = apply(held, first.write);
  assert.deepEqual(finishWaitingOnMe({ ...input, records: kept }), { completed: [id], changed: 0, write: [] });
  assert.deepEqual(verifyWaitingCompletion({ ids: [id], request_key: 'sample-done', records: kept }), { completed: [id] });
  const reopened = kept.map(record => ({ ...record, value: { ...record.value, status: 'Open' } }));
  assert.throws(() => finishWaitingOnMe({ ...input, records: reopened }), { code: 'original_command_conflict' });
  assert.throws(() => verifyWaitingCompletion({ ids: [id], request_key: 'sample-done', records: reopened }), { code: 'original_command_conflict' });
  assert.throws(() => finishWaitingOnMe({ ids: ['post:sample'], request_key: 'sample-post', records: [{ id: 'post:sample', type: 'post', value: {} }] }), /source owner/);
  assert.throws(() => finishWaitingOnMe({ ids: [id], request_key: 'sample-done' }), /records is the current waiting records/);
});

test('a round completion counts only one round on retry and closes only the final planned round', () => {
  const id = 'record:waiting-on-you:rounds';
  const held = [waiting(id, { what: 'Run the sample round', status: 'Waiting', round_step: 'Try the sample', rounds_done: 0, rounds_planned: 2 })];
  const context = { now: () => new Date('2026-01-01T12:00:00.000Z') };
  const first = { ids: [id], showed: { [id]: 'The sample worked' }, request_key: 'sample-round-one', records: held };
  const one = finishWaitingOnMe(first, context);
  assert.deepEqual(one.next_round, [id]);
  assert.equal(one.write[0].value.status, 'Waiting');
  assert.equal(one.write[0].value.rounds_done, 1);
  const afterOne = apply(held, one.write);
  assert.equal(finishWaitingOnMe({ ...first, records: afterOne }, context).changed, 0, 'a retry never counts the round twice');
  const moved = afterOne.map(record => ({ ...record, value: { ...record.value, rounds_done: 7 } }));
  assert.throws(() => finishWaitingOnMe({ ...first, records: moved }, context), { code: 'original_command_conflict' });
  const two = finishWaitingOnMe({ ids: [id], request_key: 'sample-round-two', records: afterOne }, context);
  assert.deepEqual(two.completed, [id]);
  assert.equal(two.write[0].value.status, 'Done');
  assert.equal(two.write[0].value.rounds_done, 2);
  const finished = apply(afterOne, two.write);
  assert.equal(finishWaitingOnMe({ ids: [id], request_key: 'sample-already-finished', records: finished }, context).write[0].value.rounds_done, 2, 'a finished plan never counts another round');
});

const ask = waiting('record:waiting-on-you:sample', { what: 'Sign the sample paper form', status: 'Waiting', needs: 'sign by hand', only_you_because: 'Their own signature', response: { kind: 'press', label: 'I signed the paper' } });

test('the packaged read tool uses its record rights', async () => {
  const registry = DATA.sources.map(source => own(`source:${source.id}`, { id: source.id, title: '{what}', where: [], read: { type: 'record:waiting-on-you' } }));
  const read = await answerOf(rowOf(ROWS, 'tool:read-what-is-waiting-on-me'), {}, { records: [...registry, ask] });
  assert.equal(read.status, 0, read.error);
  assert.equal(read.result.complete, true);
  assert.equal(read.result.sections.find(section => section.id === 'asks').cards[0].id, ask.id);
});

test('the finish and verify tools hold no records door at all, and their answers hold the result', async () => {
  const id = ask.id;
  for (const tool of ['tool:finish-what-is-waiting-on-me', 'tool:verify-waiting-on-me-completion']) assert.equal(rowOf(ROWS, tool).invoke.records, undefined, `${tool} is handed no records door`);
  const finish = await answerOf(rowOf(ROWS, 'tool:finish-what-is-waiting-on-me'), { ids: [id], request_key: 'sample-container-done', records: [ask] });
  assert.equal(finish.status, 0, finish.error);
  assert.deepEqual(finish.result.completed, [id]);
  assert.equal(finish.result.write[0].value.status, 'Done', 'the answer holds the completion');
  assert.deepEqual(finish.calls, [], 'no records call is made');
  const verify = await answerOf(rowOf(ROWS, 'tool:verify-waiting-on-me-completion'), { ids: [id], request_key: 'sample-container-done', records: apply([ask], finish.result.write) });
  assert.equal(verify.status, 0, verify.error);
  assert.deepEqual(verify.result.completed, [id]);
  assert.deepEqual(verify.calls, []);
});

test('complete requires every declared source; one denied or failed configured read stays unread', async () => {
  const records = DATA.sources.map(source => own(`source:${source.id}`, { id: source.id, title: '{title}', where: [], read: { type: 'record:sample-waits' } }));
  records.push({ id: 'record:sample-waits:one', type: 'record:sample-waits', value: { title: 'A sample request' } });
  const full = await readWaitingOnMe({}, { door: doorOf(records) });
  assert.equal(full.complete, true);
  assert.equal(full.sections.length, DATA.sources.length);
  const plain = doorOf(records);
  const refused = await readWaitingOnMe({}, { door: { ...plain, list: async function* (query) {
    if (query.type === 'record:sample-waits') throw new Error('record rights refused');
    yield* plain.list(query);
  } } });
  assert.equal(refused.complete, false);
  assert.ok(refused.sources.every(source => source.unread));
});

test('source tool pages advance to the end and an uncontinued partial answer is never complete', async () => {
  const configured = DATA.sources.map(source => own(`source:${source.id}`, { id: source.id, applicable: false, because: 'Outside this synthetic source scope.' }));
  configured.push(own('source:sample-paged', { id: 'sample-paged', title: '{title}', read: { tool: 'tool:sample', records: 'rows', cursor: 'after', next: 'next', more: 'more' } }));
  const pages = [];
  const full = await readWaitingOnMe({}, { door: doorOf(configured, { 'tool:sample': input => {
    pages.push(input.after ?? null);
    return input.after ? { rows: [{ id: 'sample:2', title: 'Second sample' }], next: null } : { rows: [{ id: 'sample:1', title: 'First sample' }], next: 'second' };
  } }) });
  assert.equal(full.complete, true);
  assert.deepEqual(pages, [null, 'second']);
  const broken = await readWaitingOnMe({}, { door: doorOf(configured, { 'tool:sample': () => ({ rows: [], more: true }) }) });
  assert.equal(broken.complete, false);
  assert.equal(broken.sources.find(source => source.id === 'sample-paged').unread, true);
});
