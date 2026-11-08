import test from 'node:test';
import assert from 'node:assert/strict';
import { readWaitingOnMe, finishWaitingOnMe, verifyWaitingCompletion } from '../read-data/waiting-records.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import DATA from '../read-data/waiting-sources.json' with { type: 'json' };
import ROWS from '../tool-rows.json' with { type: 'json' };
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const doorOf = (records = [], runs = {}) => ({
  list: async function* ({ type }) { for (const record of records) if (record.type === type) yield record; },
  run: async (tool, input) => { if (!runs[tool]) throw new Error('No reader is installed.'); return runs[tool](input); },
});
const own = (id, value) => ({ id, type: DATA.registry_type, value });

test('current record and reader-tool sources compose once, while unported owners remain unread', async () => {
  const record = { id: 'record:waiting-on-you:sample', type: 'record:waiting-on-you', value: { what: 'Sign the sample form', do_it_in: '/sample/form', status: 'Open' } };
  let decisionReads = 0;
  const post = { id: 'post:sample', type: 'post', value: { post_id: 'post:sample', caption: 'A sample post', status: 'draft', media: { identity: 'sample-file' } } };
  const answer = await readWaitingOnMe({}, { door: doorOf([record, post], {
    'tool:my-notification-devices': () => ({ devices: [{ device_id: 'sample-device', label: 'Sample phone', can_show: 'denied', turn_on: '/sample/settings' }] }),
    'tool:see-my-decisions': () => { decisionReads++; return { summaries: [{ case_id: 'source:sample', goal: 'A sample decision', status: 'needs_decision' }], next_before: null }; },
  }) });
  assert.equal(answer.complete, false);
  assert.equal(answer.sections.find(section => section.id === 'asks').cards[0].id, record.id);
  assert.equal(answer.sections.find(section => section.id === 'decide').cards[0].id, 'source:sample');
  assert.equal(answer.sections.find(section => section.id === 'turn-on-notices').cards[0].address, '/sample/settings');
  assert.equal(decisionReads, 1, 'decision and outcome sections share the same source read');
  assert.equal(answer.sections.find(section => section.id === 'approve').cards[0].artifact_identity, 'sample-file');
  assert.equal(answer.sections.find(section => section.id === 'approve').cards[0].address, '/use/check-a-post/post:sample');
  assert.equal(answer.sources.find(source => source.id === 'given').unread, true);
  assert.match(answer.said, /not read|unread|could not/i);
});

test('Done changes and reads back the same ask record, retries are safe, and another source cannot be guessed done', async () => {
  const fake = await startFakeDoor({ rights: [
    { kind: DATA.registry_type, operations: ['records:list'] },
    { kind: 'record:waiting-on-you', operations: ['records:read', 'records:write'] },
  ], records: [{ id: 'record:waiting-on-you:sample', type: 'record:waiting-on-you', value: { what: 'Sign the sample form', status: 'Waiting' } }] });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const input = { ids: ['record:waiting-on-you:sample'], request_key: 'sample-done' };
    assert.deepEqual(await finishWaitingOnMe(input, { door }), { completed: input.ids, changed: 1 });
    assert.equal(fake.kept.get(input.ids[0]).value.status, 'Done');
    assert.deepEqual(await finishWaitingOnMe(input, { door }), { completed: input.ids, changed: 0 });
    assert.deepEqual(await verifyWaitingCompletion(input, { door }), { completed: input.ids });
    const completed = fake.kept.get(input.ids[0]);
    fake.kept.set(input.ids[0], { ...completed, value: { ...completed.value, status: 'Open' } });
    await assert.rejects(finishWaitingOnMe(input, { door }), { code: 'original_command_conflict' });
    await assert.rejects(verifyWaitingCompletion(input, { door }), { code: 'original_command_conflict' });
    assert.equal(fake.kept.get(input.ids[0]).value.status, 'Open', 'replaying an old completion never closes a reopened row');
    await assert.rejects(finishWaitingOnMe({ ids: ['post:sample'], request_key: 'sample-post' }, { door }), /source owner/);
    assert.equal(fake.kept.has('post:sample'), false);
  } finally { await fake.close(); }
});

test('a round completion counts only one round on retry and closes only the final planned round', async () => {
  const id = 'record:waiting-on-you:rounds';
  const fake = await startFakeDoor({ rights: rowOf(ROWS, 'tool:finish-what-is-waiting-on-me').invoke.records.rights,
    records: [{ id, type: 'record:waiting-on-you', value: { what: 'Run the sample round', status: 'Waiting', round_step: 'Try the sample', rounds_done: 0, rounds_planned: 2 } }] });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const context = { door, now: () => new Date('2026-01-01T12:00:00.000Z') };
    const first = { ids: [id], showed: { [id]: 'The sample worked' }, request_key: 'sample-round-one' };
    assert.deepEqual((await finishWaitingOnMe(first, context)).next_round, [id]);
    assert.equal(fake.kept.get(id).value.status, 'Waiting');
    await finishWaitingOnMe(first, context);
    assert.equal(fake.kept.get(id).value.rounds_done, 1);
    const firstRound = fake.kept.get(id);
    fake.kept.set(id, { ...firstRound, value: { ...firstRound.value, rounds_done: 7 } });
    await assert.rejects(finishWaitingOnMe(first, context), { code: 'original_command_conflict' });
    assert.equal(fake.kept.get(id).value.rounds_done, 7, 'a retry never advances or rewrites changed round progress');
    fake.kept.set(id, firstRound);
    assert.deepEqual((await finishWaitingOnMe({ ids: [id], request_key: 'sample-round-two' }, context)).completed, [id]);
    assert.equal(fake.kept.get(id).value.status, 'Done');
    assert.equal(fake.kept.get(id).value.rounds_done, 2);
    await finishWaitingOnMe({ ids: [id], request_key: 'sample-already-finished' }, context);
    assert.equal(fake.kept.get(id).value.rounds_done, 2, 'a finished plan never counts another round');
  } finally { await fake.close(); }
});

test('the packaged read and completion tools use their declared record rights and read the same target back', async () => {
  const id = 'record:waiting-on-you:sample';
  const registry = DATA.sources.map(source => own(`source:${source.id}`, { id: source.id, title: '{what}', where: [], read: { type: 'record:waiting-on-you' } }));
  const records = [...registry, { id, type: 'record:waiting-on-you', value: { what: 'A sample task', status: 'Waiting' } }];
  const read = await answerOf(rowOf(ROWS, 'tool:read-what-is-waiting-on-me'), {}, { records });
  assert.equal(read.status, 0, read.error);
  assert.equal(read.result.complete, true);
  assert.equal(read.result.sections.find(section => section.id === 'asks').cards[0].id, id);
  const finish = await answerOf(rowOf(ROWS, 'tool:finish-what-is-waiting-on-me'), { ids: [id], request_key: 'sample-container-done' }, { records });
  assert.equal(finish.status, 0, finish.error);
  assert.deepEqual(finish.result.completed, [id]);
  assert.equal(finish.kept.find(record => record.id === id).value.status, 'Done');
  const verify = await answerOf(rowOf(ROWS, 'tool:verify-waiting-on-me-completion'), { ids: [id], request_key: 'sample-container-done' }, { records: finish.kept });
  assert.equal(verify.status, 0, verify.error);
  assert.deepEqual(verify.result.completed, [id]);
  assert.ok(!verify.calls.some(call => call.method === 'records:write'), 'current proof reads the same source and mutates nothing');
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
