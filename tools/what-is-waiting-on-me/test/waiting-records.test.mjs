import test from 'node:test';
import assert from 'node:assert/strict';
import { readWaitingOnMe, finishWaitingOnMe, verifyWaitingCompletion } from '../read-data/waiting-records.mjs';
import DATA from '../read-data/waiting-sources.json' with { type: 'json' };
import ROWS from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const own = (id, value) => ({ id, type: DATA.registry_type, value });

const apply = (held, keep) => held.map(record => keep.find(item => item.id === record.id) ?? record).map(({ expected: _expected, ...record }) => record);
const waiting = (id, value) => ({ id, type: 'record:waiting-on-you', value });



test('Done answers the completion as keep for the same ask record, a retry is safe, and another source cannot be guessed done', () => {
  const id = 'record:waiting-on-you:sample';
  const held = [waiting(id, { what: 'Sign the sample form', status: 'Waiting' })];
  const input = { ids: [id], request_key: 'sample-done', records: held };
  const first = finishWaitingOnMe(input);
  assert.deepEqual({ completed: first.completed, changed: first.changed }, { completed: [id], changed: 1 });
  assert.equal(first.keep[0].value.status, 'Done', 'the answer holds the result');
  assert.deepEqual(first.keep[0].expected, { type: 'record:waiting-on-you', value: held[0].value }, 'the keep expects the value that was read');
  assert.equal(held[0].value.status, 'Waiting', 'nothing is changed in what was handed in');
  const kept = apply(held, first.keep);
  assert.deepEqual(finishWaitingOnMe({ ...input, records: kept }), { completed: [id], changed: 0, keep: [] });
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
  assert.equal(one.keep[0].value.status, 'Waiting');
  assert.equal(one.keep[0].value.rounds_done, 1);
  const afterOne = apply(held, one.keep);
  assert.equal(finishWaitingOnMe({ ...first, records: afterOne }, context).changed, 0, 'a retry never counts the round twice');
  const moved = afterOne.map(record => ({ ...record, value: { ...record.value, rounds_done: 7 } }));
  assert.throws(() => finishWaitingOnMe({ ...first, records: moved }, context), { code: 'original_command_conflict' });
  const two = finishWaitingOnMe({ ids: [id], request_key: 'sample-round-two', records: afterOne }, context);
  assert.deepEqual(two.completed, [id]);
  assert.equal(two.keep[0].value.status, 'Done');
  assert.equal(two.keep[0].value.rounds_done, 2);
  const finished = apply(afterOne, two.keep);
  assert.equal(finishWaitingOnMe({ ids: [id], request_key: 'sample-already-finished', records: finished }, context).keep[0].value.rounds_done, 2, 'a finished plan never counts another round');
});


test('current record and reader-tool sources compose, the pages are handed in, and an unhanded page stays unread', () => {
  const record = { id: 'record:waiting-on-you:sample', type: 'record:waiting-on-you', value: { what: 'Sign the sample form', do_it_in: '/sample/form', status: 'Open', round_step: 'Run a sample tasting', rounds_done: 1, progress: 'One sample tasting recorded' } };
  const post = { id: 'post:sample', type: 'post', value: { post_id: 'post:sample', caption: 'A sample post', status: 'draft', media: { identity: 'sample-file' } } };
  const pages = {
    'tool:my-notification-devices': [{ devices: [{ device_id: 'sample-device', label: 'Sample phone', can_show: 'denied', turn_on: '/sample/settings' }] }],
    'tool:see-my-decisions': [{ summaries: [{ case_id: 'source:sample', goal: 'A sample decision', status: 'needs_decision' }], next_before: null }],
  };
  const answer = readWaitingOnMe({ stored: [record, post], pages });
  assert.equal(answer.complete, false);
  const ask = answer.sections.find(section => section.id === 'asks').cards[0];
  assert.equal(ask.id, record.id);
  assert.equal(ask.round_step, record.value.round_step);
  assert.equal(ask.rounds_done, 1);
  assert.equal(ask.progress, record.value.progress);
  assert.equal(answer.sections.find(section => section.id === 'decide').cards[0].id, 'source:sample');
  assert.equal(answer.sections.find(section => section.id === 'turn-on-notices').cards[0].address, '/sample/settings');
  assert.equal(answer.sections.find(section => section.id === 'approve').cards[0].artifact_identity, 'sample-file');
  assert.equal(answer.sections.find(section => section.id === 'approve').cards[0].address, '/use/check-a-post/post:sample');
  assert.equal(answer.sources.find(source => source.id === 'given').unread, true);
  assert.match(answer.said, /not read|unread|could not/i);
  const unhanded = readWaitingOnMe({ stored: [record, post] });
  assert.equal(unhanded.sources.find(source => source.id === 'decide').unread, true, 'a reader whose pages were not handed in is unread, never nothing waiting');
  assert.equal(unhanded.complete, false);
});

test('the records are the ones handed in: a store query the handed-in records cannot answer is unread', () => {
  const stored = DATA.sources.map(source => own('source:' + source.id, { id: source.id, title: '{title}', where: [], read: { type: 'record:sample-waits', where: [{ field: 'x', equals: 1 }] } }));
  stored.push({ id: 'record:sample-waits:one', type: 'record:sample-waits', value: { title: 'A sample request' } });
  const answer = readWaitingOnMe({ stored });
  assert.equal(answer.complete, false);
  assert.ok(answer.sources.every(source => source.unread));
  assert.match(answer.waiting_sources.problems[0].error, /store query/);
});

test('complete requires every declared source to be read whole', () => {
  const stored = DATA.sources.map(source => own('source:' + source.id, { id: source.id, title: '{title}', where: [], read: { type: 'record:sample-waits' } }));
  stored.push({ id: 'record:sample-waits:one', type: 'record:sample-waits', value: { title: 'A sample request' } });
  const full = readWaitingOnMe({ stored });
  assert.equal(full.complete, true);
  assert.equal(full.sections.length, DATA.sources.length);
  assert.equal(readWaitingOnMe({ stored: [] }).sources.find(source => source.id === 'given').unread, true, 'a source with no reader is unread');
  assert.equal(readWaitingOnMe({ stored: stored.filter(record => record.type !== 'record:sample-waits') }).sources.find(source => source.id === 'voices').waiting, 0, 'a configured type with no records is an empty read, not an unread one');
  assert.throws(() => readWaitingOnMe({}), /stored is the person/);
});

test('source tool pages advance to the end and an uncontinued partial answer is never complete', () => {
  const stored = DATA.sources.map(source => own('source:' + source.id, { id: source.id, applicable: false, because: 'Outside this synthetic source scope.' }));
  stored.push(own('source:sample-paged', { id: 'sample-paged', title: '{title}', read: { tool: 'tool:sample', records: 'rows', cursor: 'after', next: 'next', more: 'more' } }));
  const full = readWaitingOnMe({ stored, pages: { 'tool:sample': [{ rows: [{ id: 'sample:1', title: 'First sample' }], next: 'second' }, { rows: [{ id: 'sample:2', title: 'Second sample' }], next: null }] } });
  assert.equal(full.complete, true);
  assert.equal(full.sections.find(section => section.id === 'sample-paged').total, 2);
  const stopped = readWaitingOnMe({ stored, pages: { 'tool:sample': [{ rows: [{ id: 'sample:1', title: 'First sample' }], next: 'second' }] } });
  assert.equal(stopped.sources.find(source => source.id === 'sample-paged').unread, true);
  const broken = readWaitingOnMe({ stored, pages: { 'tool:sample': [{ rows: [], more: true }] } });
  assert.equal(broken.complete, false);
  assert.equal(broken.sources.find(source => source.id === 'sample-paged').unread, true);
});

const ask = waiting('record:waiting-on-you:sample', { what: 'Sign the sample paper form', status: 'Waiting', needs: 'sign by hand', only_you_because: 'Their own signature', response: { kind: 'press', label: 'I signed the paper' } });

test('the packaged read tool is pure: the records it reads are handed in, and it holds no records right', async () => {
  const registry = DATA.sources.map(source => own('source:' + source.id, { id: source.id, title: '{what}', where: [], read: { type: 'record:waiting-on-you' } }));
  const row = rowOf(ROWS, 'tool:read-what-is-waiting-on-me');
  assert.equal(row.invoke.records, undefined, 'the read tool holds no records door or tool run');
  assert.equal(row.invoke.files.package_files.some(file => file.package === 'records-door'), false);
  const read = await answerOf(row, { stored: [...registry, ask] });
  assert.equal(read.status, 0, read.error);
  assert.equal(read.result.complete, true);
  assert.equal(read.result.sections.find(section => section.id === 'asks').cards[0].id, ask.id);
});

test('the finish and verify tools hold no records door at all, and their answers hold the result', async () => {
  const id = ask.id;
  for (const tool of ['tool:finish-what-is-waiting-on-me', 'tool:verify-waiting-on-me-completion']) {
    assert.equal(rowOf(ROWS, tool).invoke.records, undefined, tool + ' is handed no records door');
    assert.equal(rowOf(ROWS, tool).invoke.files.package_files.some(file => file.package === 'records-door'), false);
  }
  const finish = await answerOf(rowOf(ROWS, 'tool:finish-what-is-waiting-on-me'), { ids: [id], request_key: 'sample-container-done', records: [ask] });
  assert.equal(finish.status, 0, finish.error);
  assert.deepEqual(finish.result.completed, [id]);
  assert.equal(finish.result.keep[0].value.status, 'Done', 'the answer holds the completion');
  assert.deepEqual(finish.calls, [], 'no records call is made');
  const verify = await answerOf(rowOf(ROWS, 'tool:verify-waiting-on-me-completion'), { ids: [id], request_key: 'sample-container-done', records: apply([ask], finish.result.keep) });
  assert.equal(verify.status, 0, verify.error);
  assert.deepEqual(verify.result.completed, [id]);
  assert.deepEqual(verify.calls, []);
});
