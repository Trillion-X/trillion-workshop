// The task rows (task-moves.mjs) run the way the Workshop runs them: each call gets the records its input carries
// (`input.records`, read by the caller from the store), and its `keep` writes are applied to the store by this test (the
// caller's part), each conditioned on the value it was read at, so a write whose condition no longer holds is refused
// whole. Made-up people, AIs, a raccoon and tasks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { changeATask, finishATask, giveATask, requestedOutcome, seeTasks, seeWhoCanTakeWork, takeATask, taskRules } from '../task-moves.mjs';

const TOOLS = fileURLToPath(new URL('../../', import.meta.url));
const CHANGED = 'original_command_conflict';
const TASK = 'record:calendar-task:';

// The store the caller keeps: records by id. Applying a call's keep writes it the way the caller's store does: each
// write is refused whole when the record is not as it was read (null: must not exist), and a null value removes it.
function applyKeep(store, keep = []) {
  for (const { id, type, value, expected } of keep) {
    const now = store.kept.get(id) ?? null;
    if (expected === null) { if (now) throw Object.assign(new Error('The record changed since it was read.'), { code: CHANGED }); }
    else if (!now || now.type !== expected.type || makeHashCodeHexFromJson(now.value) !== makeHashCodeHexFromJson(expected.value)) {
      throw Object.assign(new Error('The record changed since it was read.'), { code: CHANGED });
    }
    if (value === null) store.kept.delete(id);
    else store.kept.set(id, { id, type, value });
  }
}
const recordsOf = store => [...store.kept.values()].map(({ id, type, value }) => ({ id, type, value }));

// Each call of the module, over the store: the records go in, the keep writes are applied, the answer returns without them.
function served(run) {
  return async (args, { store, now } = {}) => {
    const answer = await run({ ...args, input: { ...args.input, records: recordsOf(store) } }, { now });
    applyKeep(store, answer.keep);
    const { keep: _applied, ...shown } = answer;
    return shown;
  };
}
const give = served(giveATask);
const see = served(seeTasks);
const take = served(takeATask);
const seeWho = served(seeWhoCanTakeWork);
const change = served(changeATask);
// A holder's move carries the exact claim it acts on. Valid fixture moves by the taker fill it in; a stale or missing claim
// is tested by calling `change` directly.
async function move(args, { store, now }) {
  const input = { ...args.input };
  const current = store.kept.get(input.id)?.value;
  if (input.taken_at === undefined && current?.taken_by === input.as) input.taken_at = current.taken_at;
  return change({ ...args, input }, { store, now });
}
const acceptance = (outcome, parts = []) => ({ outcome, target: { type: 'fixture:consumer', id: 'fixture:destination' }, rules: ['outcome', ...parts].map(id => ({ id, path: 'readable', equals: [true], says: 'The destination must be readable.' })) });
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

const RULES = JSON.parse(readFileSync(new URL('../task-moves.json', import.meta.url), 'utf8'));
const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const rowOf = id => ROWS.find(row => row.id === id);
const T0 = Date.parse('2026-11-01T20:00:00.000Z');
const at = minutes => () => new Date(T0 + minutes * 60000);
const ai = (id, value) => ({ id, type: 'ai', value: { kind: 'cli', label: id.slice(3), ...value } });
const AIS = [
  ai('ai:north', { can: ['code', 'files'], live: { how: 'heartbeat', minutes: 60, seen_at: '2026-11-01T19:30:00.000Z' }, order: 2 }),
  ai('ai:south', { can: ['any'], live: { how: 'stream', seen_at: '2026-11-01T19:59:00.000Z' }, order: 1 }),
  ai('ai:east', { can: ['write'], live: { how: 'heartbeat', minutes: 60, seen_at: '2026-10-01T00:00:00.000Z' }, order: 3 }),
];

// The store, seeded with the made-up records and one consumer the acceptance checks name.
async function account(records = AIS) {
  const fake = { kept: new Map([...records, { id: 'fixture:destination', type: 'fixture:consumer', value: { readable: true } }].map(record => [record.id, { ...record }])), async close() {} };
  return { fake, store: () => fake };
}
const task = (fake, id) => fake.kept.get(id)?.value ?? null;
const count = fake => [...fake.kept.keys()].filter(id => id.startsWith(TASK)).length;

test('the shipped rules hold together: states once, no way out of a finished task, every action a row offers', () => {
  const rules = taskRules(RULES);
  assert.deepEqual(new Set(rules.actions), new Set(['take', 'release', 'hand-on', 'finish', 'fail', 'stuck', 'unstuck', 'withdraw', 'wait', 'resume', 'edit', 'plan', 'remove']));
  assert.deepEqual(new Set(rowOf('tool:change-a-task').input_schema.properties.action.enum), new Set(rules.actions));
  assert.throws(() => taskRules({ ...RULES, transitions: [...RULES.transitions, { action: 'reopen', from: 'Done', to: 'To do' }] }), /terminal/);
  assert.throws(() => taskRules({ ...RULES, transitions: [{ ...RULES.transitions[0], set: { taken_by: { from: 'clock' } } }] }), /not as, now, input or note/);
  assert.throws(() => taskRules({ ...RULES, read_as: { running: 'busy' } }), /not a declared state/);
  assert.throws(() => taskRules({ ...RULES, read_as: { Done: 'To do' } }), /already a declared state/);
  for (const row of ROWS) assert.equal(Object.hasOwn(row, 'record_model'), false, 'the store keeps the record shapes, not the tool row');
  for (const row of ROWS) assert.equal(/records:(read|write|list|search)\b/.test(JSON.stringify(row)), false, `${row.id} names no records method`);
  for (const id of ['tool:take-a-task', 'tool:change-a-task', 'tool:finish-a-task']) {
    const schema = rowOf(id).input_schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties, 'take_request'), false, 'callers cannot supply claim-origin metadata');
  }
});

test('a task is given once per key, to named assignees or to anyone, and an unknown assignee is refused', async () => {
  const { fake, store } = await account();
  try {
    const sent = await give({ input: { as: 'ai:north', description: 'Tidy the notes folder', outcome: 'One folder per month', assignees: ['ai:south'], key: 'tidy-1' } }, { store: store(), now: at(0) });
    assert.equal(sent.status, 'written');
    assert.equal(sent.task_id, `${TASK}tidy-1`);
    assert.deepEqual(task(fake, `${TASK}tidy-1`), { title: 'Tidy the notes folder', status: 'To do', assignees: ['ai:south'], sent_by: 'ai:north', priority: 'medium', sent_at: '2026-11-01T20:00:00.000Z', description: 'Tidy the notes folder', outcome: 'One folder per month' });
    const again = await give({ input: { as: 'ai:north', description: 'Something else', key: 'tidy-1' } }, { store: store(), now: at(5) });
    assert.equal(again.status, 'already-there');
    assert.equal(again.task.description, 'Tidy the notes folder', 'the task already there is unchanged');
    const anyone = await give({ input: { as: 'ai:north', description: 'Anyone may do this' }, task: { request_key: 'run-7' } }, { store: store(), now: at(1) });
    assert.equal(anyone.task_id, `${TASK}run-7`);
    assert.deepEqual(task(fake, `${TASK}run-7`).assignees, [], 'no assignee named: anyone may take it');
    const retried = await give({ input: { as: 'ai:north', description: 'Anyone may do this' }, task: { request_key: 'run-7' } }, { store: store(), now: at(1) });
    assert.equal(retried.status, 'written', 'the same run sent again is answered its own receipt');
    assert.equal(count(fake), 2, 'and writes no second task');
    await assert.rejects(give({ input: { as: 'ai:north', description: 'x', assignees: ['ai:nobody'], key: 'k' } }, { store: store() }), /is not among the records handed in/);
    // Anyone is named by their id in whatever form the store gives it: a plain name works like a kind-prefixed id.
    assert.equal((await give({ input: { as: 'north', description: 'x', key: 'plain-name' } }, { store: store() })).task.sent_by, 'north');
    await assert.rejects(give({ input: { as: '', description: 'x', key: 'k' } }, { store: store() }), /as must be words/);
    await assert.rejects(give({ input: { as: 'ai:north', description: 'x', key: 'k', priority: 'extreme' } }, { store: store() }), /must be one of/);
    await assert.rejects(give({ input: { as: 'ai:north', description: 'x', key: 'has space' } }, { store: store() }), /key must be/);
  } finally { await fake.close(); }
});

test('two AIs take the same waiting task at once: exactly one write is applied, the other is refused whole and changes nothing', async () => {
  const { fake, store } = await account();
  try {
    await give({ input: { as: 'ai:east', description: 'Rename the photos', key: 'race' } }, { store: store(), now: at(0) });
    // Both AIs read the same store before either write lands.
    const read = recordsOf(fake);
    const north = await takeATask({ input: { as: 'ai:north', id: `${TASK}race`, records: read } }, { now: at(1) });
    const south = await takeATask({ input: { as: 'ai:south', id: `${TASK}race`, records: read } }, { now: at(1) });
    assert.equal(north.taken.status, 'In progress');
    assert.equal(south.taken.status, 'In progress');
    applyKeep(fake, north.keep);
    assert.throws(() => applyKeep(fake, south.keep), { code: CHANGED }, 'the second take was conditioned on the waiting task it read, which is gone');
    assert.equal(task(fake, `${TASK}race`).status, 'In progress');
    assert.equal(task(fake, `${TASK}race`).taken_by, 'ai:north', 'the first take won');
    assert.deepEqual(north.keep.map(write => write.expected.value.status), ['To do']);
    assert.deepEqual(south.keep.map(write => write.expected.value.status), ['To do'], 'both takes were conditioned on the waiting task they read');
  } finally { await fake.close(); }
});

test('two AIs taking the next task at once: the loser of the write takes the next task when it decides again', async () => {
  const { fake, store } = await account();
  try {
    await give({ input: { as: 'ai:east', description: 'First', key: 'one', priority: 'high' } }, { store: store(), now: at(0) });
    await give({ input: { as: 'ai:east', description: 'Second', key: 'two' } }, { store: store(), now: at(1) });
    await give({ input: { as: 'ai:east', description: 'For east only', key: 'three', assignees: ['ai:east'], priority: 'urgent' } }, { store: store(), now: at(2) });
    const read = recordsOf(fake);
    const north = await takeATask({ input: { as: 'ai:north', records: read }, task: { request_key: 'n' } }, { now: at(3) });
    const south = await takeATask({ input: { as: 'ai:south', records: read }, task: { request_key: 's' } }, { now: at(3) });
    assert.equal(north.taken.id, `${TASK}one`, 'priority first, and never the task named for another AI');
    assert.equal(south.taken.id, `${TASK}one`, 'from the same store both read the same first task');
    applyKeep(fake, north.keep);
    assert.throws(() => applyKeep(fake, south.keep), { code: CHANGED });
    const again = await take({ input: { as: 'ai:south' }, task: { request_key: 's' } }, { store: store(), now: at(3) });
    assert.equal(again.taken.id, `${TASK}two`, 'the next task, read fresh');
    assert.equal(task(fake, `${TASK}three`).status, 'To do');
    assert.equal((await take({ input: { as: 'ai:north' } }, { store: store(), now: at(4) })).taken, null, 'nothing left for north');
    assert.equal((await take({ input: { as: 'ai:east', only_mine: true } }, { store: store(), now: at(4) })).taken.id, `${TASK}three`);
  } finally { await fake.close(); }
});

test('only the taker finishes or fails a task, with a result and a check; anyone may remove it once it is finished', async () => {
  const { fake, store } = await account();
  const id = `${TASK}count`;
  try {
    await give({ input: { as: 'ai:east', description: 'Count the invoices', key: 'count', acceptance: acceptance('Count the invoices') } }, { store: store(), now: at(0) });
    await take({ input: { as: 'ai:north', id } }, { store: store(), now: at(1) });
    await assert.rejects(move({ input: { as: 'ai:south', id, action: 'finish', result: 'Twelve' } }, { store: store(), now: at(2) }), /does not hold for ai:south/);
    await assert.rejects(move({ input: { as: 'ai:north', id, action: 'finish' } }, { store: store(), now: at(2) }), /needs result/);
    await assert.rejects(move({ input: { as: 'ai:north', id, action: 'remove' } }, { store: store(), now: at(2) }), /may not remove/);
    const check = { target: acceptance('Count the invoices').target, outcome: 'Count the invoices', checked_at: at(3)().toISOString(), evidence: [{ ref: 'fixture:invoice-count', observation: 'The consumer lists twelve invoices.' }] };
    const done = await move({ input: { as: 'ai:north', id, action: 'finish', result: 'Twelve invoices', summary: 'Twelve', check } }, { store: store(), now: at(3) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'In progress', to: 'Done' });
    assert.deepEqual(pick(task(fake, id), ['status', 'sent_by', 'assignees', 'taken_by', 'taken_at', 'result', 'summary', 'finished_at', 'finished_by', 'acceptance']), {
      status: 'Done', sent_by: 'ai:east', assignees: [], taken_by: 'ai:north', taken_at: '2026-11-01T20:01:00.000Z', result: 'Twelve invoices', summary: 'Twelve',
      finished_at: '2026-11-01T20:03:00.000Z', finished_by: 'ai:north', acceptance: acceptance('Count the invoices'),
    });
    await assert.rejects(move({ input: { as: 'ai:north', id, action: 'release' } }, { store: store(), now: at(4) }), /cannot be given "release"/);
    const removed = await move({ input: { as: 'ai:south', id, action: 'remove' } }, { store: store(), now: at(5) });
    assert.deepEqual({ moved: removed.moved, to: removed.to, task: removed.task }, { moved: true, to: null, task: null });
    assert.equal(fake.kept.has(id), false);
    await assert.rejects(see({ input: { id } }, { store: store() }), /No task/);

    await give({ input: { as: 'ai:east', description: 'Try the import', key: 'import' } }, { store: store(), now: at(6) });
    await take({ input: { as: 'ai:south', id: `${TASK}import` } }, { store: store(), now: at(7) });
    const failed = await move({ input: { as: 'ai:south', id: `${TASK}import`, action: 'fail', result: 'The file is empty' } }, { store: store(), now: at(8) });
    assert.equal(failed.to, 'Broken');
    assert.equal(task(fake, `${TASK}import`).result, 'The file is empty');
  } finally { await fake.close(); }
});

test('a taker gives a task back or says what blocks it; another AI may give back or take one held past the stale time', async () => {
  const { fake, store } = await account();
  const id = `${TASK}inbox`;
  try {
    await give({ input: { as: 'ai:east', description: 'Sort the inbox', key: 'inbox' } }, { store: store(), now: at(0) });
    await take({ input: { as: 'ai:north', id } }, { store: store(), now: at(1) });
    await move({ input: { as: 'ai:north', id, action: 'stuck', words: 'Needs the mail password' } }, { store: store(), now: at(2) });
    assert.deepEqual(task(fake, id).stuck, { by: 'ai:north', at: '2026-11-01T20:02:00.000Z', words: 'Needs the mail password' });
    await assert.rejects(move({ input: { as: 'ai:north', id, action: 'stuck' } }, { store: store(), now: at(2) }), /needs words/);
    await move({ input: { as: 'ai:north', id, action: 'unstuck' } }, { store: store(), now: at(3) });
    assert.equal('stuck' in task(fake, id), false);

    await assert.rejects(move({ input: { as: 'ai:south', id, action: 'release' } }, { store: store(), now: at(60) }), /does not hold for ai:south/);
    assert.equal((await take({ input: { as: 'ai:south' } }, { store: store(), now: at(60) })).taken, null, 'a fresh take is not taken over');
    const back = await move({ input: { as: 'ai:north', id, action: 'release', because: 'Out of time' } }, { store: store(), now: at(61) });
    assert.equal(back.to, 'To do');
    assert.deepEqual(task(fake, id).released, { by: 'ai:north', at: '2026-11-01T21:01:00.000Z', words: 'Out of time' });
    assert.equal('taken_by' in task(fake, id), false);

    const retaken = await take({ input: { as: 'ai:north' } }, { store: store(), now: at(62) });
    assert.equal(retaken.taken.id, id);
    assert.equal('released' in task(fake, id), false, 'a new take clears the earlier give-back');
    const stale = 62 + RULES.transitions.find(edge => edge.action === 'take' && edge.from === 'In progress').when.rules[1].params.value;
    const takenOver = await take({ input: { as: 'ai:south' } }, { store: store(), now: at(stale) });
    assert.equal(takenOver.taken.taken_by, 'ai:south', 'a task held past the stale time may be taken by another AI');
    await move({ input: { as: 'ai:north', id, action: 'release' } }, { store: store(), now: at(stale + 1) }).then(
      () => assert.fail('north no longer holds it'), error => assert.match(error.message, /does not hold for ai:north/));
  } finally { await fake.close(); }
});

test('a watcher may say an in-progress task is stuck, and its taker can still finish it', async () => {
  // A long task already taken, as a list written before these rows holds it.
  const id = `${TASK}finish:long`;
  const running = { id, type: 'calendar-task', value: { title: 'A long task', status: 'In progress', assignees: [], sent_by: 'ai:east', priority: 'medium', sent_at: '2026-11-01T20:00:00.000Z', taken_by: 'ai:north', taken_at: '2026-11-01T20:00:00.000Z', acceptance: acceptance('A long task') } };
  const { fake, store } = await account([...AIS, running]);
  try {
    const flagged = await change({ input: { as: 'ai:south', id, action: 'stuck', words: 'No change for three hours' } }, { store: store(), now: at(180) });
    assert.deepEqual({ moved: flagged.moved, from: flagged.from, to: flagged.to }, { moved: true, from: 'In progress', to: 'In progress' });
    assert.deepEqual(task(fake, id).stuck, { by: 'ai:south', at: '2026-11-01T23:00:00.000Z', words: 'No change for three hours' }, 'the note says who flagged it and when');
    assert.deepEqual((await see({ input: { status: 'In progress' } }, { store: store() })).tasks.map(one => one.id), [id], 'a task stored as taken lists as taken');
    assert.equal((await seeWho({}, { store: store(), now: at(180) })).who.find(one => one.id === 'ai:north').busy, 1, 'and counts as its taker\'s');
    await assert.rejects(move({ input: { as: 'ai:south', id, action: 'finish', result: 'Mine now' } }, { store: store(), now: at(181) }), /does not hold for ai:south/, 'flagging it does not let the watcher finish it');
    const done = await move({ input: { as: 'ai:north', id, action: 'finish', result: 'Done at last', check: { target: acceptance('A long task').target, outcome: 'A long task', checked_at: at(182)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The consumer is readable.' }] } } }, { store: store(), now: at(182) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'In progress', to: 'Done' });
    assert.equal(task(fake, id).status, 'Done');
    assert.equal('stuck' in task(fake, id), false, 'finishing clears the stuck note');
  } finally { await fake.close(); }
});

test('only the sender withdraws a waiting task; a move on a task that changed since it was read writes nothing', async () => {
  const { fake, store } = await account();
  const id = `${TASK}room`;
  try {
    await give({ input: { as: 'ai:east', description: 'Book the room', key: 'room' } }, { store: store(), now: at(0) });
    await assert.rejects(change({ input: { as: 'ai:north', id, action: 'withdraw' } }, { store: store(), now: at(1) }), /does not hold for ai:north/);
    // East reads the task waiting; before its withdraw lands, south takes it.
    const read = recordsOf(fake);
    const late = await changeATask({ input: { as: 'ai:east', id, action: 'withdraw', because: 'Not needed', records: read } }, { now: at(2) });
    await take({ input: { as: 'ai:south', id } }, { store: store(), now: at(2) });
    assert.throws(() => applyKeep(fake, late.keep), { code: CHANGED });
    assert.equal(task(fake, id).status, 'In progress', 'the withdraw changed nothing');
    await give({ input: { as: 'ai:east', description: 'Order paper', key: 'paper' } }, { store: store(), now: at(3) });
    const withdrawn = await change({ input: { as: 'ai:east', id: `${TASK}paper`, action: 'withdraw', because: 'Found some' } }, { store: store(), now: at(4) });
    assert.equal(withdrawn.to, 'Not needed');
    await assert.rejects(change({ input: { as: 'ai:east', id: `${TASK}paper`, action: 'take' } }, { store: store(), now: at(5) }), /cannot be given "take"/);
    await assert.rejects(change({ input: { as: 'ai:east', id: `${TASK}paper`, action: 'reopen' } }, { store: store(), now: at(5) }), /action must be one of/);
  } finally { await fake.close(); }
});

test('who can take work comes back live first with what each can do and how many tasks each holds', async () => {
  const { fake, store } = await account();
  try {
    await give({ input: { as: 'ai:east', description: 'A', key: 'a' } }, { store: store(), now: at(0) });
    await give({ input: { as: 'ai:east', description: 'B', key: 'b' } }, { store: store(), now: at(0) });
    await take({ input: { as: 'ai:north', id: `${TASK}a` } }, { store: store(), now: at(0) });
    await take({ input: { as: 'ai:north', id: `${TASK}b` } }, { store: store(), now: at(0) });
    // Everyone handed in is listed (the test's destination record too); the AIs are the ones compared here.
    const ais = (await seeWho({}, { store: store(), now: at(0) })).who.filter(one => one.type === 'ai');
    assert.deepEqual(ais.map(one => [one.id, one.live, one.busy]), [['ai:south', true, 0], ['ai:north', true, 2], ['ai:east', false, 0]]);
    assert.deepEqual(ais[1].value, AIS[0].value, 'every stored cell comes back as kept; no name is made here');
    const canCode = (await seeWho({ input: { can: ['code'] } }, { store: store(), now: at(0) })).who.filter(one => one.type === 'ai');
    assert.deepEqual(canCode.map(one => one.id), ['ai:south', 'ai:north']);
    const liveOnly = (await seeWho({ input: { live_only: true } }, { store: store(), now: at(45) })).who.filter(one => one.type === 'ai');
    assert.deepEqual(liveOnly.map(one => one.id), ['ai:south'], 'north was seen 75 minutes before, past its 60');
  } finally { await fake.close(); }
});

test('the task list is newest first, kept to what matches, and says when more matched', async () => {
  const { fake, store } = await account();
  try {
    for (const [minute, key, assignees] of [[0, 'w1', []], [1, 'w2', ['ai:north']], [2, 'w3', ['ai:north']]]) {
      await give({ input: { as: 'ai:east', description: key, key, assignees } }, { store: store(), now: at(minute) });
    }
    await take({ input: { as: 'ai:north', id: `${TASK}w2` } }, { store: store(), now: at(3) });
    assert.deepEqual((await see({}, { store: store() })).tasks.map(one => one.id), [`${TASK}w3`, `${TASK}w2`, `${TASK}w1`]);
    assert.deepEqual((await see({ input: { status: 'To do' } }, { store: store() })).tasks.map(one => one.id), [`${TASK}w3`, `${TASK}w1`]);
    const newestOfNorth = await see({ input: { assignee: 'ai:north', limit: 1 } }, { store: store() });
    assert.deepEqual(newestOfNorth, { tasks: [(await see({ input: { id: `${TASK}w3` } }, { store: store() })).tasks[0]], more: true });
    assert.deepEqual((await see({ input: { taken_by: 'ai:north' } }, { store: store() })).tasks.map(one => one.id), [`${TASK}w2`]);
    await assert.rejects(see({ input: { status: 'lost' } }, { store: store() }), /status must be one of/);
  } finally { await fake.close(); }
});

test('completion keeps its source and checks every requested obligation; text, partial and stale checks stay open', async () => {
  const { fake, store } = await account();
  const id = `${TASK}consumer`;
  try {
    const outcome = 'The sample is readable in the destination';
    const input = { as: 'ai:east', key: 'consumer', description: 'Import the sample', outcome, acceptance: acceptance(outcome, ['read']), source: { kind: 'file', ref: 'fixture:sample' }, obligations: [{ id: 'read', outcome: 'The destination returns the sample words' }] };
    await give({ input }, { store: store(), now: at(0) });
    await take({ input: { as: 'ai:north', id } }, { store: store(), now: at(1) });
    const finish = { taken_at: at(1)().toISOString(), as: 'ai:north', id, action: 'finish', result: 'Imported the sample' };
    await assert.rejects(move({ input: finish }, { store: store(), now: at(3) }), /needs check/);
    const check = { target: input.acceptance.target, outcome, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination-read', observation: 'The destination returns the sample words.' }] };
    await assert.rejects(move({ input: { ...finish, check } }, { store: store(), now: at(3) }), /every saved obligation/);
    check.obligations = [{ ...input.obligations[0], evidence: check.evidence }];
    await assert.rejects(move({ input: { ...finish, check: { ...check, outcome: 'A commit exists' } } }, { store: store(), now: at(3) }), /saved requested outcome/);
    await assert.rejects(move({ input: { ...finish, check: { ...check, checked_at: at(0)().toISOString() } } }, { store: store(), now: at(3) }), /during this take/);
    assert.equal(task(fake, id).status, 'In progress');
    fake.kept.get('fixture:destination').value.readable = false;
    await assert.rejects(move({ input: { ...finish, check } }, { store: store(), now: at(3) }), /requested outcome is not checked/);
    assert.equal(task(fake, id).status, 'In progress', 'fabricated observation text cannot override the actual failed consumer');
    fake.kept.get('fixture:destination').value.readable = true;
    const done = await move({ input: { ...finish, check }, task: { request_key: 'finish-consumer' } }, { store: store(), now: at(3) });
    assert.equal(done.to, 'Done');
    assert.deepEqual(done.task.source, input.source);
    const retry = await move({ input: { ...finish, check }, task: { request_key: 'finish-consumer' } }, { store: store(), now: at(4) });
    assert.equal(retry.replayed, true);
    await assert.rejects(move({ input: { ...finish, check, result: 'different' }, task: { request_key: 'finish-consumer' } }, { store: store(), now: at(4) }), /different input/);
    assert.equal(count(fake), 1, 'completion creates no automatic follow-up task');
  } finally { await fake.close(); }
});

test('an old run of the same AI cannot finish a newer take, and an old request receipt cannot fabricate ownership', async () => {
  const { fake, store } = await account();
  const id = `${TASK}fence`;
  try {
    await give({ input: { as: 'ai:east', key: 'fence', description: 'Check the consumer', acceptance: acceptance('Check the consumer') } }, { store: store(), now: at(0) });
    const first = await take({ input: { as: 'ai:north', id }, task: { request_key: 'old-take' } }, { store: store(), now: at(1) });
    await move({ input: { as: 'ai:north', id, action: 'release' }, task: { request_key: 'release-fence' } }, { store: store(), now: at(2) });
    const replay = await take({ input: { as: 'ai:north', id }, task: { request_key: 'old-take' } }, { store: store(), now: at(3) });
    assert.equal(replay.taken, null);
    assert.equal(task(fake, id).status, 'To do');
    const second = await take({ input: { as: 'ai:north', id }, task: { request_key: 'new-take' } }, { store: store(), now: at(4) });
    const check = { target: acceptance('Check the consumer').target, outcome: 'Check the consumer', checked_at: at(5)().toISOString(), evidence: [{ ref: 'fabricated:ref', observation: 'A fabricated claim of success' }] };
    await assert.rejects(change({ input: { as: 'ai:north', id, action: 'finish', result: 'Done', check, taken_at: first.taken.taken_at } }, { store: store(), now: at(5) }), /exact current claim/);
    await assert.rejects(change({ input: { as: 'ai:north', id, action: 'finish', result: 'Done', check } }, { store: store(), now: at(5) }), /exact current claim/);
    assert.equal(task(fake, id).taken_at, second.taken.taken_at);
  } finally { await fake.close(); }
});

test('a next-task take replays its original claim before a higher-priority arrival', async () => {
  const { fake, store } = await account();
  try {
    await give({ input: { as: 'ai:east', key: 'first-claim', description: 'Original work', priority: 'medium' } }, { store: store(), now: at(0) });
    const request = { input: { as: 'ai:north' }, task: { request_key: 'one-next-task-take' } };
    const first = await take(request, { store: store(), now: at(1) });
    await give({ input: { as: 'ai:east', key: 'later-priority', description: 'New urgent work', priority: 'urgent' } }, { store: store(), now: at(2) });
    const retry = await take(request, { store: store(), now: at(3) });
    assert.equal(retry.taken.id, first.taken.id);
    assert.equal(retry.taken.taken_at, first.taken.taken_at);
    await move({ input: { as: 'ai:north', id: first.taken.id, action: 'stuck', words: 'An observed dependency needs review' }, task: { request_key: 'progress-after-take' } }, { store: store(), now: at(4) });
    const afterNote = await take(request, { store: store(), now: at(5) });
    assert.equal(afterNote.taken.id, first.taken.id, 'a progress note does not erase the original claim request');
    assert.equal(afterNote.taken.taken_at, first.taken.taken_at);
    assert.equal(task(fake, `${TASK}later-priority`).status, 'To do');
    assert.deepEqual([...fake.kept.values()].filter(row => row.type === 'calendar-task' && row.value.status === 'In progress').map(row => row.id), [first.taken.id]);
    await move({ input: { as: 'ai:north', id: first.taken.id, action: 'release' } }, { store: store(), now: at(6) });
    const afterRelease = await take(request, { store: store(), now: at(7) });
    assert.equal(afterRelease.taken, null, 'an ended original claim cannot be replayed as ownership or acquire fresh work');
    assert.equal(task(fake, `${TASK}later-priority`).status, 'To do');
  } finally { await fake.close(); }
});

test('a take replay reads the current claim and refuses a replaced or removed claim', async () => {
  for (const how of ['replaced', 'same-ai-replaced', 'removed']) {
    const { fake, store } = await account();
    try {
      await give({ input: { as: 'ai:east', key: 'read-current', description: 'Original work' } }, { store: store(), now: at(0) });
      const request = { input: { as: 'ai:north' }, task: { request_key: 'replay-current-claim' } };
      const first = await take(request, { store: store(), now: at(1) });
      await give({ input: { as: 'ai:east', key: 'fresh-current', description: 'Fresh urgent work', priority: 'urgent' } }, { store: store(), now: at(2) });
      // The claim changes in the store before the replay reads it.
      if (how === 'removed') fake.kept.delete(first.taken.id);
      else fake.kept.get(first.taken.id).value = { ...task(fake, first.taken.id), taken_at: at(4)().toISOString(), taken_by: how === 'same-ai-replaced' ? 'ai:north' : 'ai:south' };
      const replay = await take(request, { store: store(), now: at(5) });
      if (how === 'removed') {
        assert.equal(replay.taken.id, `${TASK}fresh-current`, 'a removed claim has nothing to replay: the next task is taken');
      } else {
        assert.equal(replay.taken, null);
        assert.equal(replay.reason, 'changed');
        assert.equal(task(fake, `${TASK}fresh-current`).status, 'To do');
      }
    } finally { await fake.close(); }
  }
});

test('a legacy last-move-only take receipt cannot supply the missing original claim fence', async () => {
  const { fake, store } = await account();
  try {
    await give({ input: { as: 'ai:east', key: 'legacy-replay', description: 'Legacy work' } }, { store: store(), now: at(0) });
    const request = { input: { as: 'ai:north' }, task: { request_key: 'legacy-take-request' } };
    const first = await take(request, { store: store(), now: at(1) });
    const legacy = task(fake, first.taken.id);
    delete legacy.take_request;
    legacy.taken_at = at(4)().toISOString();
    assert.ok(legacy.last_move.key, 'the legacy receipt retains the matching request but no original take timestamp');
    const replay = await take(request, { store: store(), now: at(5) });
    assert.equal(replay.taken, null, 'a current same-AI take timestamp cannot fill missing original proof');
    assert.equal(replay.reason, 'changed');
    assert.equal(task(fake, first.taken.id).taken_at, legacy.taken_at);
  } finally { await fake.close(); }
});

test('a taker plans missing acceptance or repeats it unchanged, without replacing saved consumer checks', async () => {
  const { fake, store } = await account();
  try {
    const outcome = 'The destination is readable';
    const saved = acceptance(outcome);
    await give({ input: { as: 'ai:east', key: 'plan-once', description: outcome } }, { store: store(), now: at(0) });
    const first = await take({ input: { as: 'ai:north', id: `${TASK}plan-once` } }, { store: store(), now: at(1) });
    const plan = { as: 'ai:north', id: first.taken.id, taken_at: first.taken.taken_at, action: 'plan', acceptance: saved };
    await change({ input: plan, task: { request_key: 'plan-consumer' } }, { store: store(), now: at(2) });
    assert.equal((await change({ input: plan, task: { request_key: 'plan-consumer' } }, { store: store(), now: at(3) })).replayed, true);
    await change({ input: plan, task: { request_key: 'same-plan-new-request' } }, { store: store(), now: at(3) });
    const weaker = { ...saved, rules: [{ id: 'outcome', path: 'readable', equals: [false] }] };
    await assert.rejects(change({ input: { ...plan, acceptance: weaker } }, { store: store(), now: at(4) }), /cannot replace the saved acceptance/);
    assert.deepEqual(task(fake, first.taken.id).acceptance, saved);
    fake.kept.get('fixture:destination').value.readable = false;
    await assert.rejects(change({ input: { as: plan.as, id: plan.id, taken_at: plan.taken_at, action: 'finish', result: 'A claim of completion', check: { target: saved.target, outcome, checked_at: at(5)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The current destination was read' }] } } }, { store: store(), now: at(5) }), /requested outcome is not checked/);
    assert.equal(task(fake, first.taken.id).status, 'In progress');

    await give({ input: { as: 'ai:east', key: 'sender-plan', description: outcome, acceptance: saved } }, { store: store(), now: at(0) });
    const second = await take({ input: { as: 'ai:north', id: `${TASK}sender-plan` } }, { store: store(), now: at(1) });
    await assert.rejects(change({ input: { ...plan, id: second.taken.id, taken_at: second.taken.taken_at, acceptance: weaker } }, { store: store(), now: at(4) }), /cannot replace the saved acceptance/);
    assert.deepEqual(task(fake, second.taken.id).acceptance, saved);
  } finally { await fake.close(); }
});

test('a plan is checked against the task as this edge saves it, and a rule path that selects nothing is refused with the target fields', async () => {
  const { fake, store } = await account();
  try {
    const outcome = 'The destination is readable';
    await give({ input: { as: 'ai:east', key: 'plan-judged', description: outcome } }, { store: store(), now: at(0) });
    const taken = await take({ input: { as: 'ai:north', id: `${TASK}plan-judged` } }, { store: store(), now: at(1) });
    const plan = { as: 'ai:north', id: taken.taken.id, taken_at: taken.taken.taken_at, action: 'plan' };
    await assert.rejects(change({ input: { ...plan, acceptance: acceptance('Some other outcome') } }, { store: store(), now: at(2) }), /outcome/);
    assert.equal(task(fake, taken.taken.id).acceptance, undefined);
    const silent = { ...acceptance(outcome), rules: [{ id: 'outcome', path: 'missing_field', equals: [true] }] };
    await assert.rejects(change({ input: { ...plan, acceptance: silent } }, { store: store(), now: at(2) }), /"missing_field" selects nothing on fixture:consumer fixture:destination; its fields are readable/);
    assert.equal(task(fake, taken.taken.id).acceptance, undefined);
    await change({ input: { ...plan, acceptance: acceptance(outcome) } }, { store: store(), now: at(3) });
    assert.deepEqual(task(fake, taken.taken.id).acceptance, acceptance(outcome));
  } finally { await fake.close(); }
});

test('the sender edits waiting work in the shared action owner; unrelated callers cannot change its acceptance', async () => {
  const { fake, store } = await account();
  const id = `${TASK}edit`;
  try {
    await give({ input: { as: 'ai:east', key: 'edit', description: 'Check the consumer' } }, { store: store(), now: at(0) });
    await assert.rejects(change({ input: { as: 'ai:north', id, action: 'edit', acceptance: acceptance('Check the consumer') } }, { store: store(), now: at(1) }), /does not hold/);
    await change({ input: { as: 'ai:east', id, action: 'edit', acceptance: acceptance('Check the consumer') } }, { store: store(), now: at(1) });
    assert.deepEqual(task(fake, id).acceptance, acceptance('Check the consumer'));
    await take({ input: { as: 'ai:north', id } }, { store: store(), now: at(2) });
    await assert.rejects(change({ input: { as: 'ai:east', id, action: 'edit', description: 'A weaker goal' } }, { store: store(), now: at(3) }), /cannot be given/);
  } finally { await fake.close(); }
});

test('an owned bounded recovery resumes the same task; early and unrelated callers cannot wake it', async () => {
  const { fake, store } = await account();
  const id = `${TASK}recover`;
  try {
    await give({ input: { as: 'ai:east', key: 'recover', description: 'Read the destination' } }, { store: store(), now: at(0) });
    const take1 = { input: { as: 'ai:north', id }, task: { request_key: 'take-recover' } };
    await take(take1, { store: store(), now: at(1) });
    assert.equal((await take(take1, { store: store(), now: at(2) })).taken.taken_by, 'ai:north', 'same take replay does not need stale takeover');
    const continuation = { owner: 'ai:south', action: 'Retry the destination read', after: at(10)().toISOString(), reason: 'The destination returned a temporary unavailable response' };
    await move({ input: { as: 'ai:north', id, action: 'wait', continuation } }, { store: store(), now: at(3) });
    assert.equal(task(fake, id).status, 'Waiting');
    await assert.rejects(move({ input: { as: 'ai:south', id, action: 'resume', because: 'The dependency was checked and is available again' } }, { store: store(), now: at(9) }), /does not hold/);
    await assert.rejects(move({ input: { as: 'ai:unrelated', id, action: 'resume', because: 'The dependency was checked and is available again' } }, { store: store(), now: at(10) }), /does not hold/);
    await move({ input: { as: 'ai:south', id, action: 'resume', because: 'The dependency was checked and is available again' } }, { store: store(), now: at(10) });
    assert.equal((await take({ input: { as: 'ai:south', id } }, { store: store(), now: at(10) })).taken.taken_by, 'ai:south');
    await move({ input: { as: 'ai:south', id, action: 'release', continuation: { ...continuation, after: at(20)().toISOString() } } }, { store: store(), now: at(11) });
    assert.equal((await take({ input: { as: 'ai:south' } }, { store: store(), now: at(12) })).taken, null, 'bounded release does not spin immediately');
    assert.equal(count(fake), 1);
  } finally { await fake.close(); }
});

// The row runs as the Workshop runs it: its invoke run through the engine's runner, with the input and task on standard input.
function runRow(id, input, task = {}) {
  const [node, runner, file, name] = rowOf(id).invoke.run;
  const local = path => path.replace(/^\/opt\//, TOOLS);
  const run = spawnSync(node, [local(runner), local(file), name], { input: JSON.stringify({ input, task }), encoding: 'utf8' });
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('each row runs as the container runs it, with its records in its input and its writes answered as keep', async () => {
  const records = [...AIS, { id: `${TASK}row`, type: 'calendar-task', value: { title: 'From a row', status: 'To do', assignees: [], sent_by: 'ai:east', priority: 'medium', sent_at: '2026-11-01T20:00:00.000Z', description: 'From a row' } }];
  const sent = runRow('tool:give-a-task', { as: 'ai:east', description: 'Water the plants', assignees: ['ai:north'], records }, { request_key: 'row-send' });
  assert.equal(sent.result.task_id, `${TASK}row-send`, JSON.stringify(sent));
  assert.equal(sent.result.keep[0].expected, null);
  const taken = runRow('tool:take-a-task', { as: 'ai:north', records }, { request_key: 'row-take' });
  assert.equal(taken.result.taken.id, `${TASK}row`);
  assert.equal(taken.result.keep.find(record => record.id === `${TASK}row`).value.taken_by, 'ai:north');
  const moved = runRow('tool:change-a-task', { as: 'ai:east', id: `${TASK}row`, action: 'withdraw', records }, { request_key: 'row-move' });
  assert.equal(moved.result.to, 'Not needed');
  const work = runRow('tool:see-tasks', { status: 'To do', records });
  assert.deepEqual(work.result.tasks.map(one => one.id), [`${TASK}row`]);
  const who = runRow('tool:see-who-can-take-work', { records });
  assert.deepEqual(who.result.who.filter(one => one.type === 'ai').map(one => one.id).sort(), ['ai:east', 'ai:north', 'ai:south']);
  const held = { ...records.at(-1), value: { ...records.at(-1).value, status: 'In progress', taken_by: 'ai:north', taken_at: at(1)().toISOString(), acceptance: acceptance('From a row') } };
  const checked = runRow('tool:finish-a-task', {
    as: 'ai:north', id: held.id, taken_at: held.value.taken_at, result: 'Read the consumer',
    check: { target: held.value.acceptance.target, outcome: 'From a row', checked_at: at(2)().toISOString(), evidence: [{ ref: 'fabricated:claim', observation: 'The claim alone is never sufficient.' }] },
    records: [...AIS.filter(one => one.id !== 'ai:east'), held, { id: 'fixture:destination', type: 'fixture:consumer', value: { readable: true } }],
  });
  assert.equal(checked.result.to, 'Done', JSON.stringify(checked));
  assert.match(checked.result.task.check.consumer.identity, /^1f:/, 'the packaged action checked actual consumer bytes');
});

test('the most characters a result takes inline is one number: the rules\' most_chars for the result of finish and of fail is the maxLength the changing rows state', () => {
  const asked = RULES.transitions.filter(row => row.set?.result?.most_chars !== undefined).map(row => row.set.result.most_chars);
  assert.ok(asked.length >= 2, 'finish and fail both bound the result');
  for (const id of ['tool:change-a-task', 'tool:finish-a-task']) {
    for (const most of asked) assert.equal(rowOf(id).input_schema.properties.result.maxLength, most, id);
  }
});

test('a task asks for its outcome, else its description when that is words, else its title', () => {
  assert.equal(requestedOutcome({ outcome: 'Done is this', description: 'Do that', title: 'Name' }), 'Done is this');
  assert.equal(requestedOutcome({ description: 'Do that', title: 'Name' }), 'Do that');
  assert.equal(requestedOutcome({ description: [{ id: 'dig' }], title: 'Name' }), 'Name', 'a description that is a list of steps is not words');
  assert.equal(requestedOutcome({ outcome: '  ', description: [], title: 'Name' }), 'Name');
  assert.equal(requestedOutcome({ description: [] }), undefined);
});

test('two lane tasks, each named to its own lane, are each taken, planned and finished by that lane, and no lane takes the other\'s', async () => {
  const lanes = ['ai:dig-1-lane', 'ai:dig-2-lane'];
  const laneTask = (lane, outcome) => ({ id: `${TASK}run:dig:${lane.slice(3)}`, type: 'calendar-task', value: { title: `Run: Dig, lane ${lane}`, status: 'To do', assignees: [lane], sent_by: 'ai:east', priority: 'medium', sent_at: '2026-11-01T20:00:00.000Z', description: `Run: Dig, lane ${lane}`, ...(outcome ? { outcome } : {}) } });
  const { fake, store } = await account([...AIS, ...lanes.map(lane => ai(lane, { can: ['any'], order: 9 })), laneTask(lanes[0], `Run: Dig, lane ${lanes[0]}`), laneTask(lanes[1], null)]);
  try {
    const taken = [];
    for (const [index, lane] of lanes.entries()) {
      const id = `${TASK}run:dig:${lane.slice(3)}`;
      const other = `${TASK}run:dig:${lanes[1 - index].slice(3)}`;
      await assert.rejects(take({ input: { as: lane, id: other } }, { store: store(), now: at(1 + index) }), /does not hold/, `${lane} may not take the other lane's task`);
      taken.push({ lane, id, taken_at: (await take({ input: { as: lane, id } }, { store: store(), now: at(1 + index) })).taken.taken_at });
    }
    for (const { lane, id, taken_at } of taken.reverse()) {
      const outcome = requestedOutcome(task(fake, id));
      await change({ input: { as: lane, id, taken_at, action: 'plan', acceptance: acceptance(outcome) } }, { store: store(), now: at(5) });
      const check = { target: acceptance(outcome).target, outcome, checked_at: at(6)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The destination is readable.' }] };
      const done = await change({ input: { as: lane, id, taken_at, action: 'finish', result: 'The lane is done', check } }, { store: store(), now: at(6) });
      assert.deepEqual({ moved: done.moved, to: done.to }, { moved: true, to: 'Done' }, `${lane} finished its own task`);
    }
    assert.deepEqual(lanes.map(lane => task(fake, `${TASK}run:dig:${lane.slice(3)}`).status), ['Done', 'Done']);
  } finally { await fake.close(); }
});

test('a finish of a task with no saved acceptance says how its taker saves one, and a task given already taken is then finished', async () => {
  const sent = { id: `${TASK}sent`, type: 'calendar-task', value: { title: 'Land the change', status: 'In progress', assignees: [], sent_by: 'ai:east', priority: 'medium', sent_at: '2026-11-01T19:00:00.000Z', description: 'Land the change', taken_by: 'ai:north', taken_at: '2026-11-01T20:00:00.000Z' } };
  const { fake, store } = await account([...AIS, sent]);
  try {
    const outcome = 'Land the change';
    const check = { target: acceptance(outcome).target, outcome, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The destination is readable.' }] };
    await assert.rejects(move({ input: { as: 'ai:north', id: sent.id, action: 'finish', result: 'Landed', check } }, { store: store(), now: at(3) }), /the plan move with an acceptance/);
    await move({ input: { as: 'ai:north', id: sent.id, action: 'plan', acceptance: acceptance(outcome) } }, { store: store(), now: at(1) });
    const done = await move({ input: { as: 'ai:north', id: sent.id, action: 'finish', result: 'Landed', check } }, { store: store(), now: at(3) });
    assert.equal(done.to, 'Done');
  } finally { await fake.close(); }
});

test('a person gives a task to an AI, the AI takes it and hands it on to a person, and the person takes and finishes it', async () => {
  const { fake, store } = await account([...AIS, { id: 'person:someone', type: 'person', value: { label: 'Someone' } }]);
  const id = `${TASK}invoice`;
  try {
    const outcome = 'The invoice is sent';
    await give({ input: { as: 'person:someone', description: 'Send the invoice to the client', outcome, acceptance: acceptance(outcome), assignees: ['ai:north'], key: 'invoice' } }, { store: store(), now: at(0) });
    await take({ input: { as: 'ai:north', id } }, { store: store(), now: at(1) });
    const handed = await move({ input: { as: 'ai:north', id, action: 'hand-on', assignees: ['person:someone'], because: 'Needs a person to approve the amount' } }, { store: store(), now: at(2) });
    assert.deepEqual({ moved: handed.moved, from: handed.from, to: handed.to }, { moved: true, from: 'In progress', to: 'To do' });
    assert.deepEqual(task(fake, id).assignees, ['person:someone']);
    assert.equal('taken_by' in task(fake, id), false, 'the hand-on gives the task back with no taker');
    await assert.rejects(take({ input: { as: 'ai:north', id } }, { store: store(), now: at(3) }), /does not hold for ai:north/);
    await take({ input: { as: 'person:someone', id } }, { store: store(), now: at(3) });
    assert.equal(task(fake, id).taken_by, 'person:someone');
    const done = await move({ input: { as: 'person:someone', id, action: 'finish', result: 'Sent after approval', check: { target: acceptance(outcome).target, outcome, checked_at: at(4)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The consumer is readable.' }] } } }, { store: store(), now: at(4) });
    assert.equal(done.to, 'Done');
    assert.equal(task(fake, id).sent_by, 'person:someone');
  } finally { await fake.close(); }
});

test('a task named to several assignees may be taken by any one of them, and by no one else', async () => {
  const { fake, store } = await account();
  try {
    await give({ input: { as: 'ai:east', key: 'draft', description: 'Review the draft', assignees: ['ai:north', 'ai:south'] } }, { store: store(), now: at(0) });
    await assert.rejects(take({ input: { as: 'ai:east', id: `${TASK}draft` } }, { store: store(), now: at(1) }), /does not hold for ai:east/);
    assert.equal((await take({ input: { as: 'ai:east' } }, { store: store(), now: at(1) })).taken, null, 'nothing is open to east');
    assert.equal((await take({ input: { as: 'ai:south', id: `${TASK}draft` } }, { store: store(), now: at(1) })).taken.taken_by, 'ai:south');
    await give({ input: { as: 'ai:east', key: 'draft-2', description: 'Review the second draft', assignees: ['ai:north', 'ai:south'] } }, { store: store(), now: at(2) });
    assert.equal((await take({ input: { as: 'ai:north', id: `${TASK}draft-2` } }, { store: store(), now: at(3) })).taken.taken_by, 'ai:north');
    assert.equal(count(fake), 2);
  } finally { await fake.close(); }
});

test('a raccoon id works as assignee and taker exactly like any other record id', async () => {
  const { fake, store } = await account([...AIS, { id: 'raccoon:bob', type: 'raccoon', value: { label: 'Bob' } }]);
  const id = `${TASK}trap`;
  try {
    const outcome = 'The trap is cleared';
    await give({ input: { as: 'ai:north', key: 'trap', description: 'Clear the trap', outcome, acceptance: acceptance(outcome), assignees: ['raccoon:bob'] } }, { store: store(), now: at(0) });
    await assert.rejects(take({ input: { as: 'ai:south', id } }, { store: store(), now: at(1) }), /does not hold for ai:south/);
    assert.equal((await take({ input: { as: 'raccoon:bob', id } }, { store: store(), now: at(1) })).taken.taken_by, 'raccoon:bob');
    assert.equal((await seeWho({}, { store: store(), now: at(1) })).who.find(one => one.id === 'raccoon:bob').busy, 1, 'it holds one task like an AI');
    const done = await move({ input: { as: 'raccoon:bob', id, action: 'finish', result: 'Cleared', check: { target: acceptance(outcome).target, outcome, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The consumer is readable.' }] } } }, { store: store(), now: at(2) });
    assert.equal(done.to, 'Done');
  } finally { await fake.close(); }
});

test('a task with no assignees may be taken by anyone, one at a time, by a person, an AI or a raccoon', async () => {
  const { fake, store } = await account([...AIS, { id: 'person:someone', type: 'person', value: { label: 'Someone' } }, { id: 'raccoon:bob', type: 'raccoon', value: { label: 'Bob' } }]);
  try {
    for (const [minute, key] of [[0, 'any-1'], [1, 'any-2'], [2, 'any-3']]) await give({ input: { as: 'ai:east', key, description: key } }, { store: store(), now: at(minute) });
    assert.equal((await take({ input: { as: 'person:someone', id: `${TASK}any-1` } }, { store: store(), now: at(3) })).taken.taken_by, 'person:someone');
    assert.equal((await take({ input: { as: 'ai:north' } }, { store: store(), now: at(3) })).taken.id, `${TASK}any-2`, 'the AI gets the next one');
    assert.equal((await take({ input: { as: 'raccoon:bob', id: `${TASK}any-3` } }, { store: store(), now: at(3) })).taken.taken_by, 'raccoon:bob');
  } finally { await fake.close(); }
});

test('takes come in priority order: urgent before high, high before medium, medium before low, then oldest first', async () => {
  const { store } = await account();
  await give({ input: { as: 'ai:east', description: 'Low one', key: 'low', priority: 'low' } }, { store: store(), now: at(0) });
  await give({ input: { as: 'ai:east', description: 'Medium one', key: 'medium' } }, { store: store(), now: at(1) });
  await give({ input: { as: 'ai:east', description: 'Urgent one', key: 'urgent', priority: 'urgent' } }, { store: store(), now: at(2) });
  await give({ input: { as: 'ai:east', description: 'High one', key: 'high', priority: 'high' } }, { store: store(), now: at(3) });
  const order = [];
  for (let minute = 4; minute < 8; minute += 1) order.push((await take({ input: { as: 'ai:north' } }, { store: store(), now: at(minute) })).taken.title);
  assert.deepEqual(order, ['Urgent one', 'High one', 'Medium one', 'Low one']);
});

test('a task named to an assignee that is not among the records handed in is refused', async () => {
  const { fake, store } = await account();
  await assert.rejects(give({ input: { as: 'ai:east', description: 'Ghost task', assignees: ['ai:ghost'], key: 'ghost' } }, { store: store(), now: at(0) }), /ai:ghost is not among the records handed in/);
  assert.equal(fake.kept.has(`${TASK}ghost`), false);
  await give({ input: { as: 'ai:east', description: 'Real task', assignees: ['ai:north'], key: 'real' } }, { store: store(), now: at(0) });
  await assert.rejects(change({ input: { as: 'ai:east', id: `${TASK}real`, action: 'hand-on', assignees: ['ai:ghost'], because: 'Nobody' } }, { store: store(), now: at(1) }), /ai:ghost is not among the records handed in/);
  assert.deepEqual(task(fake, `${TASK}real`).assignees, ['ai:north']);
});

test('the finish row is the finish action of the change row, with the same rules', async () => {
  const { fake, store } = await account();
  const id = `${TASK}same-rules`;
  await give({ input: { as: 'ai:east', key: 'same-rules', description: 'Same rules', acceptance: acceptance('Same rules') } }, { store: store(), now: at(0) });
  await take({ input: { as: 'ai:north', id } }, { store: store(), now: at(1) });
  const check = { target: acceptance('Same rules').target, outcome: 'Same rules', checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The consumer is readable.' }] };
  await assert.rejects(finishATask({ input: { as: 'ai:south', id, taken_at: at(1)().toISOString(), result: 'Not mine', check, records: recordsOf(fake) } }, { now: at(2) }), /does not hold for ai:south/);
  const done = await finishATask({ input: { as: 'ai:north', id, taken_at: at(1)().toISOString(), result: 'Mine', check, records: recordsOf(fake) } }, { now: at(2) });
  assert.equal(done.to, 'Done');
  assert.equal(done.from, 'In progress');
  applyKeep(fake, done.keep);
  assert.equal(task(fake, id).status, 'Done');
});
