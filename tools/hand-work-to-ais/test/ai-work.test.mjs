// The work handed between a person's AIs, run the way the Workshop runs it: each call gets the records its input carries
// (`input.records`, read by the caller from the store), and its `keep` writes are applied to the store by the test (the
// caller's part), each conditioned on the value it was read at, so a write whose condition no longer holds is refused
// whole. Made-up AIs and jobs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { handAJob as handAJobRaw, moveAJob as moveRaw, requestedOutcome, seeAiWork as seeAiWorkRaw, seeMyAis as seeMyAisRaw, takeAJob as takeAJobRaw, workRules } from '../read-data/ai-work.mjs';

const TOOLS = fileURLToPath(new URL('../../', import.meta.url));
const rowOf = (rows, id) => rows.records.map(row => row.payload).find(row => row.id === id);

// The store the caller keeps: records by id. Applying a call's keep writes it the way the caller's store does: each
// write is refused whole when the record is not as it was read (null: must not exist), and a null value removes it.
const CHANGED = 'original_command_conflict';
const conflict = () => Object.assign(new Error('The record changed since it was read.'), { code: CHANGED });
function applyKeep(store, keep = []) {
  for (const { id, type, value, expected } of keep) {
    const now = store.kept.get(id) ?? null;
    if (expected === null) { if (now) throw conflict(); }
    else if (!now || now.type !== expected.type || makeHashCodeHexFromJson(now.value) !== makeHashCodeHexFromJson(expected.value)) throw conflict();
    if (value === null) store.kept.delete(id);
    else store.kept.set(id, { id, type, value });
  }
}
const recordsOf = store => [...store.kept.values()].map(({ id, type, value }) => ({ id, type, value }));

// Each call of the module, over the store: the records go in, the keep writes are applied, the answer returns.
function served(run) {
  return async (args, { store, now } = {}) => {
    const answer = await run({ ...args, input: { ...args.input, records: recordsOf(store) } }, { now });
    applyKeep(store, answer.keep);
    const { keep: _applied, ...shown } = answer;
    return shown;
  };
}
const handAJob = served(handAJobRaw);
const takeAJob = served(takeAJobRaw);
const seeAiWork = served(seeAiWorkRaw);
const seeMyAis = served(seeMyAisRaw);
const moveActual = served(moveRaw);
// Valid fixture moves carry the take generation. Explicit stale/missing-fence controls call moveActual directly.
async function moveAJob(args, { store, now }) {
  const input = { ...args.input };
  const current = store.kept.get(input.id)?.value;
  if (input.taken_at === undefined && current?.taker === input.as) input.taken_at = current.taken_at;
  return moveActual({ ...args, input }, { store, now });
}
const acceptance = (outcome, parts = []) => ({ outcome, target: { type: 'fixture:consumer', id: 'fixture:destination' }, rules: ['outcome', ...parts].map(id => ({ id, path: 'readable', equals: [true], says: 'The destination must be readable.' })) });

const RULES = JSON.parse(readFileSync(new URL('../read-data/ai-work.json', import.meta.url), 'utf8'));
const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const T0 = Date.parse('2026-11-01T20:00:00.000Z');
const at = minutes => () => new Date(T0 + minutes * 60000);
const ai = (id, value) => ({ id, type: 'ai', value: { kind: 'cli', label: id.slice(3), ...value } });
const AIS = [
  ai('ai:north', { can: ['code', 'files'], live: { how: 'heartbeat', minutes: 60, seen_at: '2026-11-01T19:30:00.000Z' }, order: 2 }),
  ai('ai:south', { can: ['any'], live: { how: 'stream', seen_at: '2026-11-01T19:59:00.000Z' }, order: 1 }),
  ai('ai:east', { can: ['write'], live: { how: 'heartbeat', minutes: 60, seen_at: '2026-10-01T00:00:00.000Z' }, order: 3 }),
];

// The store, seeded with the made-up AIs and one consumer the acceptance checks name.
async function account(records = AIS) {
  const fake = { kept: new Map([...records, { id: 'fixture:destination', type: 'fixture:consumer', value: { readable: true } }].map(record => [record.id, { ...record }])), async close() {} };
  return { fake, store: () => fake };
}
const job = (fake, id) => fake.kept.get(id)?.value ?? null;

test('the shipped rules hold together: states once, no way out of a finished job, every action a row offers', () => {
  const rules = workRules(RULES);
  assert.deepEqual(rules.actions, ['take', 'release', 'finish', 'fail', 'stuck', 'unstuck', 'withdraw', 'wait', 'resume', 'edit', 'plan', 'remove']);
  assert.deepEqual(new Set(rowOf(ROWS, 'tool:change-an-ai-job').input_schema.properties.action.enum), new Set(rules.actions));
  assert.throws(() => workRules({ ...RULES, transitions: [...RULES.transitions, { action: 'reopen', from: 'done', to: 'waiting' }] }), /terminal/);
  assert.throws(() => workRules({ ...RULES, transitions: [{ ...RULES.transitions[0], set: { taker: { from: 'clock' } } }] }), /not as, now, input or note/);
  for (const row of ROWS.records.map(one => one.payload)) assert.equal(Object.hasOwn(row, 'record_model'), false, 'the store keeps the record shapes, not the tool row');
  for (const row of ROWS.records.map(one => one.payload)) assert.equal(/records:(read|write|list|search)\b/.test(JSON.stringify(row)), false, `${row.id} names no records method`);
  for (const id of ['tool:take-an-ai-job', 'tool:change-an-ai-job', 'tool:finish-an-ai-job']) {
    const schema = rowOf(ROWS, id).input_schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties, 'take_request'), false, 'callers cannot supply claim-origin metadata');
  }
  assert.throws(() => workRules({ ...RULES, read_as: { running: 'busy' } }), /not a declared state/);
  assert.throws(() => workRules({ ...RULES, read_as: { done: 'taken' } }), /already a declared state/);
});

test('a job is handed once per key, to a named AI or to any, and an unknown AI is refused', async () => {
  const { fake, store } = await account();
  try {
    const sent = await handAJob({ input: { as: 'ai:north', job: 'Tidy the notes folder', to: 'ai:south', key: 'tidy-1', outcome: 'One folder per month' } }, { store: store(), now: at(0) });
    assert.equal(sent.status, 'written');
    assert.equal(sent.job_id, 'ai-job:tidy-1');
    assert.deepEqual(job(fake, 'ai-job:tidy-1'), { kind: 'ai-job', status: 'waiting', job: 'Tidy the notes folder', to: 'ai:south', from: 'ai:north', priority: 5, sent_at: '2026-11-01T20:00:00.000Z', outcome: 'One folder per month' });
    const again = await handAJob({ input: { as: 'ai:north', job: 'Something else', key: 'tidy-1' } }, { store: store(), now: at(5) });
    assert.equal(again.status, 'already-there');
    assert.equal(again.job.job, 'Tidy the notes folder', 'the job already there is unchanged');
    const anyone = await handAJob({ input: { as: 'ai:north', job: 'Anyone may do this' }, task: { request_key: 'run-7' } }, { store: store(), now: at(1) });
    assert.equal(anyone.job_id, 'ai-job:run-7');
    assert.equal(job(fake, 'ai-job:run-7').to, null);
    const retried = await handAJob({ input: { as: 'ai:north', job: 'Anyone may do this' }, task: { request_key: 'run-7' } }, { store: store(), now: at(1) });
    assert.equal(retried.status, 'written', 'the same run sent again is answered its own receipt');
    assert.equal([...fake.kept.keys()].filter(id => id.startsWith('ai-job:')).length, 2, 'and writes no second job');
    await assert.rejects(handAJob({ input: { as: 'ai:north', job: 'x', to: 'ai:nobody', key: 'k' } }, { store: store() }), /No AI ai:nobody/);
    await assert.rejects(handAJob({ input: { as: 'north', job: 'x', key: 'k' } }, { store: store() }), /record id, ai:/);
    await assert.rejects(handAJob({ input: { as: 'ai:north', job: 'x', key: 'k', priority: 12 } }, { store: store() }), /0 to 9/);
    await assert.rejects(handAJob({ input: { as: 'ai:north', job: 'x', key: 'has space' } }, { store: store() }), /key must be/);
  } finally { await fake.close(); }
});

test('two AIs take the same waiting job at once: exactly one write is applied, the other is refused whole and changes nothing', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Rename the photos', key: 'race' } }, { store: store(), now: at(0) });
    // Both AIs read the same store before either write lands.
    const read = recordsOf(fake);
    const north = await takeAJobRaw({ input: { as: 'ai:north', id: 'ai-job:race', records: read } }, { now: at(1) });
    const south = await takeAJobRaw({ input: { as: 'ai:south', id: 'ai-job:race', records: read } }, { now: at(1) });
    assert.equal(north.taken.status, 'taken');
    assert.equal(south.taken.status, 'taken');
    applyKeep(fake, north.keep);
    assert.throws(() => applyKeep(fake, south.keep), { code: CHANGED }, 'the second take was conditioned on the waiting job it read, which is gone');
    assert.equal(job(fake, 'ai-job:race').status, 'taken');
    assert.equal(job(fake, 'ai-job:race').taker, 'ai:north', 'the first take won');
    assert.deepEqual(north.keep.map(write => write.expected.value.status), ['waiting']);
    assert.deepEqual(south.keep.map(write => write.expected.value.status), ['waiting'], 'both takes were conditioned on the waiting job they read');
  } finally { await fake.close(); }
});

test('two AIs taking the next job at once: the loser of the write takes the next job when it decides again', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'First', key: 'one', priority: 7 } }, { store: store(), now: at(0) });
    await handAJob({ input: { as: 'ai:east', job: 'Second', key: 'two' } }, { store: store(), now: at(1) });
    await handAJob({ input: { as: 'ai:east', job: 'For east only', key: 'three', to: 'ai:east', priority: 9 } }, { store: store(), now: at(2) });
    const read = recordsOf(fake);
    const north = await takeAJobRaw({ input: { as: 'ai:north', records: read }, task: { request_key: 'n' } }, { now: at(3) });
    const south = await takeAJobRaw({ input: { as: 'ai:south', records: read }, task: { request_key: 's' } }, { now: at(3) });
    assert.equal(north.taken.id, 'ai-job:one', 'priority first, and never the job addressed to another AI');
    assert.equal(south.taken.id, 'ai-job:one', 'from the same store both read the same first job');
    applyKeep(fake, north.keep);
    assert.throws(() => applyKeep(fake, south.keep), { code: CHANGED });
    const again = await takeAJob({ input: { as: 'ai:south' }, task: { request_key: 's' } }, { store: store(), now: at(3) });
    assert.equal(again.taken.id, 'ai-job:two', 'the next job, read fresh');
    assert.equal(job(fake, 'ai-job:three').status, 'waiting');
    assert.equal((await takeAJob({ input: { as: 'ai:north' } }, { store: store(), now: at(4) })).taken, null, 'nothing left for north');
    assert.equal((await takeAJob({ input: { as: 'ai:east', only_mine: true } }, { store: store(), now: at(4) })).taken.id, 'ai-job:three');
  } finally { await fake.close(); }
});

test('only the taker finishes or fails a job, with a result; anyone may remove it once it is finished', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Count the invoices', key: 'count', acceptance: acceptance('Count the invoices') } }, { store: store(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:count' } }, { store: store(), now: at(1) });
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:count', action: 'finish', result: 'Twelve' } }, { store: store(), now: at(2) }), /does not hold for ai:south/);
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'finish' } }, { store: store(), now: at(2) }), /needs result/);
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'remove' } }, { store: store(), now: at(2) }), /may not remove/);
    const check = { target: acceptance('Count the invoices').target, outcome: 'Count the invoices', checked_at: at(3)().toISOString(), evidence: [{ ref: 'fixture:invoice-count', observation: 'The consumer lists twelve invoices.' }] };
    const done = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'finish', result: 'Twelve invoices', summary: 'Twelve', check } }, { store: store(), now: at(3) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'taken', to: 'done' });
    assert.deepEqual(job(fake, 'ai-job:count'), {
      acceptance: acceptance('Count the invoices'), kind: 'ai-job', status: 'done', job: 'Count the invoices', to: null, from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z',
      taker: 'ai:north', taken_at: '2026-11-01T20:01:00.000Z', check: done.job.check, result: 'Twelve invoices', summary: 'Twelve', finished_at: '2026-11-01T20:03:00.000Z', finished_by: 'ai:north',
    });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'release' } }, { store: store(), now: at(4) }), /cannot be given "release"/);
    const removed = await moveAJob({ input: { as: 'ai:south', id: 'ai-job:count', action: 'remove' } }, { store: store(), now: at(5) });
    assert.deepEqual({ moved: removed.moved, to: removed.to, job: removed.job }, { moved: true, to: null, job: null });
    assert.equal(fake.kept.has('ai-job:count'), false);
    await assert.rejects(seeAiWork({ input: { id: 'ai-job:count' } }, { store: store() }), /No job/);

    await handAJob({ input: { as: 'ai:east', job: 'Try the import', key: 'import' } }, { store: store(), now: at(6) });
    await takeAJob({ input: { as: 'ai:south', id: 'ai-job:import' } }, { store: store(), now: at(7) });
    const failed = await moveAJob({ input: { as: 'ai:south', id: 'ai-job:import', action: 'fail', result: 'The file is empty' } }, { store: store(), now: at(8) });
    assert.equal(failed.to, 'failed');
    assert.equal(job(fake, 'ai-job:import').result, 'The file is empty');
  } finally { await fake.close(); }
});

test('a taker gives a job back or says what blocks it; another AI may give back or take one held past the stale time', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Sort the inbox', key: 'inbox' } }, { store: store(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:inbox' } }, { store: store(), now: at(1) });
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'stuck', words: 'Needs the mail password' } }, { store: store(), now: at(2) });
    assert.deepEqual(job(fake, 'ai-job:inbox').stuck, { by: 'ai:north', at: '2026-11-01T20:02:00.000Z', words: 'Needs the mail password' });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'stuck' } }, { store: store(), now: at(2) }), /needs words/);
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'unstuck' } }, { store: store(), now: at(3) });
    assert.equal('stuck' in job(fake, 'ai-job:inbox'), false);

    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:inbox', action: 'release' } }, { store: store(), now: at(60) }), /does not hold for ai:south/);
    assert.equal((await takeAJob({ input: { as: 'ai:south' } }, { store: store(), now: at(60) })).taken, null, 'a fresh take is not taken over');
    const back = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'release', because: 'Out of time' } }, { store: store(), now: at(61) });
    assert.equal(back.to, 'waiting');
    assert.deepEqual(job(fake, 'ai-job:inbox').released, { by: 'ai:north', at: '2026-11-01T21:01:00.000Z', words: 'Out of time' });
    assert.equal('taker' in job(fake, 'ai-job:inbox'), false);

    const retaken = await takeAJob({ input: { as: 'ai:north' } }, { store: store(), now: at(62) });
    assert.equal(retaken.taken.id, 'ai-job:inbox');
    assert.equal('released' in job(fake, 'ai-job:inbox'), false, 'a new take clears the earlier give-back');
    const stale = 62 + RULES.transitions.find(edge => edge.action === 'take' && edge.from === 'taken').when.rules[1].params.value;
    const takenOver = await takeAJob({ input: { as: 'ai:south' } }, { store: store(), now: at(stale) });
    assert.equal(takenOver.taken.taker, 'ai:south', 'a job held past the stale time may be taken by another AI');
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'release' } }, { store: store(), now: at(stale + 1) }).then(
      () => assert.fail('north no longer holds it'), error => assert.match(error.message, /does not hold for ai:north/));
  } finally { await fake.close(); }
});

test('a watcher may say a running job is stuck, and its taker can still finish it', async () => {
  // A long job written by another writer with the status word "running", which read_as reads as taken.
  const running = { id: 'ai-job:finish:long', type: 'ai-job', value: { kind: 'ai-job', status: 'running', job: 'A long job', to: 'ai:north', from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z', taker: 'ai:north', taken_at: '2026-11-01T20:00:00.000Z', acceptance: acceptance('A long job') } };
  const { fake, store } = await account([...AIS, running]);
  try {
    const flagged = await moveAJob({ input: { as: 'ai:south', id: 'ai-job:finish:long', action: 'stuck', words: 'No change for three hours' } }, { store: store(), now: at(180) });
    assert.deepEqual({ moved: flagged.moved, from: flagged.from }, { moved: true, from: 'running' });
    assert.equal(job(fake, 'ai-job:finish:long').status, 'running', 'a move that stays in the state keeps the stored word');
    assert.deepEqual(job(fake, 'ai-job:finish:long').stuck, { by: 'ai:south', at: '2026-11-01T23:00:00.000Z', words: 'No change for three hours' }, 'the note says who flagged it and when');
    assert.deepEqual((await seeAiWork({ input: { status: 'taken' } }, { store: store() })).jobs.map(one => one.id), ['ai-job:finish:long'], 'a running job lists as taken');
    assert.equal((await seeMyAis({}, { store: store(), now: at(180) })).ais.find(one => one.id === 'ai:north').busy, 1, 'and counts as its taker\'s');
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:finish:long', action: 'finish', result: 'Mine now' } }, { store: store(), now: at(181) }), /does not hold for ai:south/, 'flagging it does not let the watcher finish it');
    const done = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:finish:long', action: 'finish', result: 'Done at last', check: { target: acceptance('A long job').target, outcome: 'A long job', checked_at: at(182)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The consumer is readable.' }] } } }, { store: store(), now: at(182) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'running', to: 'done' });
    assert.equal(job(fake, 'ai-job:finish:long').status, 'done');
    assert.equal('stuck' in job(fake, 'ai-job:finish:long'), false, 'finishing clears the stuck note');
  } finally { await fake.close(); }
});

test('only the sender withdraws a waiting job; a move on a job that changed since it was read writes nothing', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Book the room', key: 'room' } }, { store: store(), now: at(0) });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:room', action: 'withdraw' } }, { store: store(), now: at(1) }), /does not hold for ai:north/);
    // East reads the job waiting; before its withdraw lands, south takes it.
    const read = recordsOf(fake);
    const late = await moveRaw({ input: { as: 'ai:east', id: 'ai-job:room', action: 'withdraw', because: 'Not needed', records: read } }, { now: at(2) });
    await takeAJob({ input: { as: 'ai:south', id: 'ai-job:room' } }, { store: store(), now: at(2) });
    assert.throws(() => applyKeep(fake, late.keep), { code: CHANGED });
    assert.equal(job(fake, 'ai-job:room').status, 'taken', 'the withdraw changed nothing');
    await handAJob({ input: { as: 'ai:east', job: 'Order paper', key: 'paper' } }, { store: store(), now: at(3) });
    const withdrawn = await moveAJob({ input: { as: 'ai:east', id: 'ai-job:paper', action: 'withdraw', because: 'Found some' } }, { store: store(), now: at(4) });
    assert.equal(withdrawn.to, 'withdrawn');
    await assert.rejects(moveAJob({ input: { as: 'ai:east', id: 'ai-job:paper', action: 'take' } }, { store: store(), now: at(5) }), /cannot be given "take"/);
    await assert.rejects(moveAJob({ input: { as: 'ai:east', id: 'ai-job:paper', action: 'reopen' } }, { store: store(), now: at(5) }), /action must be one of/);
  } finally { await fake.close(); }
});

test('my AIs come back live first with what each can do and how many jobs each holds', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'A', key: 'a' } }, { store: store(), now: at(0) });
    await handAJob({ input: { as: 'ai:east', job: 'B', key: 'b' } }, { store: store(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:a' } }, { store: store(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:b' } }, { store: store(), now: at(0) });
    const { ais } = await seeMyAis({}, { store: store(), now: at(0) });
    assert.deepEqual(ais.map(one => [one.id, one.live, one.busy]), [['ai:south', true, 0], ['ai:north', true, 2], ['ai:east', false, 0]]);
    assert.deepEqual(ais[1].value, AIS[0].value, 'every stored cell comes back as kept; no name is made here');
    assert.deepEqual((await seeMyAis({ input: { can: ['code'] } }, { store: store(), now: at(0) })).ais.map(one => one.id), ['ai:south', 'ai:north']);
    assert.deepEqual((await seeMyAis({ input: { live_only: true } }, { store: store(), now: at(45) })).ais.map(one => one.id), ['ai:south'], 'north was seen 75 minutes before, past its 60');
  } finally { await fake.close(); }
});

test('the work list is newest first, kept to what matches, and says when more matched', async () => {
  const { fake, store } = await account();
  try {
    for (const [minute, key, to] of [[0, 'w1', null], [1, 'w2', 'ai:north'], [2, 'w3', 'ai:north']]) {
      await handAJob({ input: { as: 'ai:east', job: key, key, to } }, { store: store(), now: at(minute) });
    }
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:w2' } }, { store: store(), now: at(3) });
    assert.deepEqual((await seeAiWork({}, { store: store() })).jobs.map(one => one.id), ['ai-job:w3', 'ai-job:w2', 'ai-job:w1']);
    assert.deepEqual((await seeAiWork({ input: { status: 'waiting' } }, { store: store() })).jobs.map(one => one.id), ['ai-job:w3', 'ai-job:w1']);
    assert.deepEqual((await seeAiWork({ input: { to: 'ai:north', limit: 1 } }, { store: store() })), { jobs: [(await seeAiWork({ input: { id: 'ai-job:w3' } }, { store: store() })).jobs[0]], more: true });
    assert.deepEqual((await seeAiWork({ input: { taker: 'ai:north' } }, { store: store() })).jobs.map(one => one.id), ['ai-job:w2']);
    await assert.rejects(seeAiWork({ input: { status: 'lost' } }, { store: store() }), /status must be one of/);
  } finally { await fake.close(); }
});

test('completion retains provenance and checks every requested obligation; text, partial and stale checks stay open', async () => {
  const { fake, store } = await account();
  try {
    const input = { as: 'ai:east', key: 'consumer', job: 'Import the sample', outcome: 'The sample is readable in the destination', acceptance: acceptance('The sample is readable in the destination', ['read']), source: { kind: 'file', ref: 'fixture:sample' }, obligations: [{ id: 'read', outcome: 'The destination returns the sample words' }] };
    await handAJob({ input }, { store: store(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:consumer' } }, { store: store(), now: at(1) });
    const finish = { taken_at: at(1)().toISOString(), as: 'ai:north', id: 'ai-job:consumer', action: 'finish', result: 'Imported the sample' };
    await assert.rejects(moveAJob({ input: finish }, { store: store(), now: at(3) }), /needs check/);
    const check = { target: input.acceptance.target, outcome: input.outcome, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination-read', observation: 'The destination returns the sample words.' }] };
    await assert.rejects(moveAJob({ input: { ...finish, check } }, { store: store(), now: at(3) }), /every saved obligation/);
    check.obligations = [{ ...input.obligations[0], evidence: check.evidence }];
    await assert.rejects(moveAJob({ input: { ...finish, check: { ...check, outcome: 'A commit exists' } } }, { store: store(), now: at(3) }), /saved requested outcome/);
    await assert.rejects(moveAJob({ input: { ...finish, check: { ...check, checked_at: at(0)().toISOString() } } }, { store: store(), now: at(3) }), /during this take/);
    assert.equal(job(fake, 'ai-job:consumer').status, 'taken');
    fake.kept.get('fixture:destination').value.readable = false;
    await assert.rejects(moveAJob({ input: { ...finish, check } }, { store: store(), now: at(3) }), /requested outcome is not checked/);
    assert.equal(job(fake, 'ai-job:consumer').status, 'taken', 'fabricated observation text cannot override the actual failed consumer');
    fake.kept.get('fixture:destination').value.readable = true;
    const done = await moveAJob({ input: { ...finish, check }, task: { request_key: 'finish-consumer' } }, { store: store(), now: at(3) });
    assert.equal(done.to, 'done');
    assert.deepEqual(done.job.source, input.source);
    const retry = await moveAJob({ input: { ...finish, check }, task: { request_key: 'finish-consumer' } }, { store: store(), now: at(4) });
    assert.equal(retry.replayed, true);
    await assert.rejects(moveAJob({ input: { ...finish, check, result: 'different' }, task: { request_key: 'finish-consumer' } }, { store: store(), now: at(4) }), /different input/);
    assert.equal([...fake.kept.keys()].filter(key => key.startsWith('ai-job:')).length, 1, 'completion creates no automatic follow-up work');
  } finally { await fake.close(); }
});

test('an old run of the same AI cannot finish a newer take, and an old request receipt cannot fabricate ownership', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'fence', job: 'Check the consumer', acceptance: acceptance('Check the consumer') } }, { store: store(), now: at(0) });
    const first = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:fence' }, task: { request_key: 'old-take' } }, { store: store(), now: at(1) });
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:fence', action: 'release' }, task: { request_key: 'release-fence' } }, { store: store(), now: at(2) });
    const replay = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:fence' }, task: { request_key: 'old-take' } }, { store: store(), now: at(3) });
    assert.equal(replay.taken, null);
    assert.equal(job(fake, 'ai-job:fence').status, 'waiting');
    const second = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:fence' }, task: { request_key: 'new-take' } }, { store: store(), now: at(4) });
    const check = { target: second.taken.acceptance.target, outcome: second.taken.job, checked_at: at(5)().toISOString(), evidence: [{ ref: 'fabricated:ref', observation: 'A fabricated claim of success' }] };
    await assert.rejects(moveActual({ input: { as: 'ai:north', id: 'ai-job:fence', action: 'finish', result: 'Done', check, taken_at: first.taken.taken_at } }, { store: store(), now: at(5) }), /exact current claim/);
    await assert.rejects(moveActual({ input: { as: 'ai:north', id: 'ai-job:fence', action: 'finish', result: 'Done', check } }, { store: store(), now: at(5) }), /exact current claim/);
    assert.equal(job(fake, 'ai-job:fence').taken_at, second.taken.taken_at);
  } finally { await fake.close(); }
});

test('a next-job take replays its original claim before a higher-priority arrival', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'first-claim', job: 'Original work', priority: 5 } }, { store: store(), now: at(0) });
    const request = { input: { as: 'ai:north' }, task: { request_key: 'one-next-job-take' } };
    const first = await takeAJob(request, { store: store(), now: at(1) });
    await handAJob({ input: { as: 'ai:east', key: 'later-priority', job: 'New urgent work', priority: 9 } }, { store: store(), now: at(2) });
    const retry = await takeAJob(request, { store: store(), now: at(3) });
    assert.equal(retry.taken.id, first.taken.id);
    assert.equal(retry.taken.taken_at, first.taken.taken_at);
    await moveAJob({ input: { as: 'ai:north', id: first.taken.id, action: 'stuck', words: 'An observed dependency needs review' }, task: { request_key: 'progress-after-take' } }, { store: store(), now: at(4) });
    const afterNote = await takeAJob(request, { store: store(), now: at(5) });
    assert.equal(afterNote.taken.id, first.taken.id, 'a progress note does not erase the original claim request');
    assert.equal(afterNote.taken.taken_at, first.taken.taken_at);
    assert.equal(job(fake, 'ai-job:later-priority').status, 'waiting');
    assert.deepEqual([...fake.kept.values()].filter(row => row.type === 'ai-job' && row.value.status === 'taken').map(row => row.id), [first.taken.id]);
    await moveAJob({ input: { as: 'ai:north', id: first.taken.id, action: 'release' } }, { store: store(), now: at(6) });
    const afterRelease = await takeAJob(request, { store: store(), now: at(7) });
    assert.equal(afterRelease.taken, null, 'an ended original claim cannot be replayed as ownership or acquire fresh work');
    assert.equal(job(fake, 'ai-job:later-priority').status, 'waiting');
  } finally { await fake.close(); }
});

test('a take replay reads the current claim and refuses a replaced or removed claim', async () => {
  for (const change of ['replaced', 'same-ai-replaced', 'removed']) {
    const { fake, store } = await account();
    try {
      await handAJob({ input: { as: 'ai:east', key: 'read-current', job: 'Original work' } }, { store: store(), now: at(0) });
      const request = { input: { as: 'ai:north' }, task: { request_key: 'replay-current-claim' } };
      const first = await takeAJob(request, { store: store(), now: at(1) });
      await handAJob({ input: { as: 'ai:east', key: 'fresh-current', job: 'Fresh urgent work', priority: 9 } }, { store: store(), now: at(2) });
      // The claim changes in the store before the replay reads it.
      if (change === 'removed') fake.kept.delete(first.taken.id);
      else fake.kept.get(first.taken.id).value = { ...job(fake, first.taken.id), taken_at: at(4)().toISOString(), taker: change === 'same-ai-replaced' ? 'ai:north' : 'ai:south' };
      const replay = await takeAJob(request, { store: store(), now: at(5) });
      if (change === 'removed') {
        assert.equal(replay.taken.id, 'ai-job:fresh-current', 'a removed claim has nothing to replay: the next job is taken');
      } else {
        assert.equal(replay.taken, null);
        assert.equal(replay.reason, 'changed');
        assert.equal(job(fake, 'ai-job:fresh-current').status, 'waiting');
      }
    } finally { await fake.close(); }
  }
});

test('a legacy last-move-only take receipt cannot supply the missing original claim fence', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'legacy-replay', job: 'Legacy work' } }, { store: store(), now: at(0) });
    const request = { input: { as: 'ai:north' }, task: { request_key: 'legacy-take-request' } };
    const first = await takeAJob(request, { store: store(), now: at(1) });
    const legacy = job(fake, first.taken.id);
    delete legacy.take_request;
    legacy.taken_at = at(4)().toISOString();
    assert.ok(legacy.last_move.key, 'the legacy receipt retains the matching request but no original take timestamp');
    const replay = await takeAJob(request, { store: store(), now: at(5) });
    assert.equal(replay.taken, null, 'a current same-AI take timestamp cannot fill missing original proof');
    assert.equal(replay.reason, 'changed');
    assert.equal(job(fake, first.taken.id).taken_at, legacy.taken_at);
  } finally { await fake.close(); }
});

test('a taker plans missing acceptance or repeats it unchanged, without replacing saved consumer checks', async () => {
  const { fake, store } = await account();
  try {
    const outcome = 'The destination is readable';
    const saved = acceptance(outcome);
    await handAJob({ input: { as: 'ai:east', key: 'plan-once', job: outcome } }, { store: store(), now: at(0) });
    const first = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:plan-once' } }, { store: store(), now: at(1) });
    const plan = { as: 'ai:north', id: first.taken.id, taken_at: first.taken.taken_at, action: 'plan', acceptance: saved };
    await moveActual({ input: plan, task: { request_key: 'plan-consumer' } }, { store: store(), now: at(2) });
    assert.equal((await moveActual({ input: plan, task: { request_key: 'plan-consumer' } }, { store: store(), now: at(3) })).replayed, true);
    await moveActual({ input: plan, task: { request_key: 'same-plan-new-request' } }, { store: store(), now: at(3) });
    const weaker = { ...saved, rules: [{ id: 'outcome', path: 'readable', equals: [false] }] };
    await assert.rejects(moveActual({ input: { ...plan, acceptance: weaker } }, { store: store(), now: at(4) }), /cannot replace the saved acceptance/);
    assert.deepEqual(job(fake, first.taken.id).acceptance, saved);
    fake.kept.get('fixture:destination').value.readable = false;
    await assert.rejects(moveActual({ input: { as: plan.as, id: plan.id, taken_at: plan.taken_at, action: 'finish', result: 'A claim of completion', check: { target: saved.target, outcome, checked_at: at(5)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The current destination was read' }] } } }, { store: store(), now: at(5) }), /requested outcome is not checked/);
    assert.equal(job(fake, first.taken.id).status, 'taken');

    await handAJob({ input: { as: 'ai:east', key: 'sender-plan', job: outcome, acceptance: saved } }, { store: store(), now: at(0) });
    const second = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:sender-plan' } }, { store: store(), now: at(1) });
    await assert.rejects(moveActual({ input: { ...plan, id: second.taken.id, taken_at: second.taken.taken_at, acceptance: weaker } }, { store: store(), now: at(4) }), /cannot replace the saved acceptance/);
    assert.deepEqual(job(fake, second.taken.id).acceptance, saved);
  } finally { await fake.close(); }
});

test('a plan is checked against the job as this edge saves it, and a rule path that selects nothing is refused with the target fields', async () => {
  const { fake, store } = await account();
  try {
    const outcome = 'The destination is readable';
    await handAJob({ input: { as: 'ai:east', key: 'plan-judged', job: outcome } }, { store: store(), now: at(0) });
    const taken = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:plan-judged' } }, { store: store(), now: at(1) });
    const plan = { as: 'ai:north', id: taken.taken.id, taken_at: taken.taken.taken_at, action: 'plan' };
    await assert.rejects(moveActual({ input: { ...plan, acceptance: acceptance('Some other outcome') } }, { store: store(), now: at(2) }), /outcome/);
    assert.equal(job(fake, taken.taken.id).acceptance, undefined);
    const silent = { ...acceptance(outcome), rules: [{ id: 'outcome', path: 'missing_field', equals: [true] }] };
    await assert.rejects(moveActual({ input: { ...plan, acceptance: silent } }, { store: store(), now: at(2) }), /"missing_field" selects nothing on fixture:consumer fixture:destination; its fields are readable/);
    assert.equal(job(fake, taken.taken.id).acceptance, undefined);
    await moveActual({ input: { ...plan, acceptance: acceptance(outcome) } }, { store: store(), now: at(3) });
    assert.deepEqual(job(fake, taken.taken.id).acceptance, acceptance(outcome));
  } finally { await fake.close(); }
});

test('the sender edits waiting work in the shared action owner; unrelated callers cannot change its acceptance', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'edit', job: 'Check the consumer' } }, { store: store(), now: at(0) });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:edit', action: 'edit', acceptance: acceptance('Check the consumer') } }, { store: store(), now: at(1) }), /does not hold/);
    await moveAJob({ input: { as: 'ai:east', id: 'ai-job:edit', action: 'edit', acceptance: acceptance('Check the consumer'), to: null } }, { store: store(), now: at(1) });
    assert.deepEqual(job(fake, 'ai-job:edit').acceptance, acceptance('Check the consumer'));
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:edit' } }, { store: store(), now: at(2) });
    await assert.rejects(moveAJob({ input: { as: 'ai:east', id: 'ai-job:edit', action: 'edit', outcome: 'A weaker goal' } }, { store: store(), now: at(3) }), /cannot be given/);
  } finally { await fake.close(); }
});

test('an owned bounded recovery resumes the same job; early and unrelated callers cannot wake it', async () => {
  const { fake, store } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'recover', job: 'Read the destination' } }, { store: store(), now: at(0) });
    const take = { input: { as: 'ai:north', id: 'ai-job:recover' }, task: { request_key: 'take-recover' } };
    await takeAJob(take, { store: store(), now: at(1) });
    assert.equal((await takeAJob(take, { store: store(), now: at(2) })).taken.taker, 'ai:north', 'same take replay does not need stale takeover');
    const continuation = { owner: 'ai:south', action: 'Retry the destination read', after: at(10)().toISOString(), reason: 'The destination returned a temporary unavailable response' };
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:recover', action: 'wait', continuation } }, { store: store(), now: at(3) });
    assert.equal(job(fake, 'ai-job:recover').status, 'blocked');
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:recover', action: 'resume', because: 'The dependency was checked and is available again' } }, { store: store(), now: at(9) }), /does not hold/);
    await assert.rejects(moveAJob({ input: { as: 'ai:unrelated', id: 'ai-job:recover', action: 'resume', because: 'The dependency was checked and is available again' } }, { store: store(), now: at(10) }), /does not hold/);
    await moveAJob({ input: { as: 'ai:south', id: 'ai-job:recover', action: 'resume', because: 'The dependency was checked and is available again' } }, { store: store(), now: at(10) });
    assert.equal((await takeAJob({ input: { as: 'ai:south', id: 'ai-job:recover' } }, { store: store(), now: at(10) })).taken.taker, 'ai:south');
    await moveAJob({ input: { as: 'ai:south', id: 'ai-job:recover', action: 'release', continuation: { ...continuation, after: at(20)().toISOString() } } }, { store: store(), now: at(11) });
    assert.equal((await takeAJob({ input: { as: 'ai:south' } }, { store: store(), now: at(12) })).taken, null, 'bounded release does not spin immediately');
    assert.equal([...fake.kept.keys()].filter(key => key.startsWith('ai-job:')).length, 1);
  } finally { await fake.close(); }
});

// The row runs as the Workshop runs it: its invoke argv through the engine's runner, with the input and task on standard input.
function runRow(id, input, task = {}) {
  const [node, runner, file, name] = rowOf(ROWS, id).invoke.argv;
  const local = path => path.replace(/^\/opt\//, TOOLS);
  const run = spawnSync(node, [local(runner), local(file), name], { input: JSON.stringify({ input, task }), encoding: 'utf8' });
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('each row runs as the container runs it, with its records in its input and its writes answered as keep', async () => {
  const records = [...AIS, { id: 'ai-job:row', type: 'ai-job', value: { kind: 'ai-job', status: 'waiting', job: 'From a row', to: null, from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z' } }];
  const sent = runRow('tool:hand-a-job-to-an-ai', { as: 'ai:east', job: 'Water the plants', to: 'ai:north', records }, { request_key: 'row-send' });
  assert.equal(sent.result.job_id, 'ai-job:row-send', JSON.stringify(sent));
  assert.equal(sent.result.keep[0].expected, null);
  const taken = runRow('tool:take-an-ai-job', { as: 'ai:north', records }, { request_key: 'row-take' });
  assert.equal(taken.result.taken.id, 'ai-job:row');
  assert.equal(taken.result.keep.find(record => record.id === 'ai-job:row').value.taker, 'ai:north');
  const moved = runRow('tool:change-an-ai-job', { as: 'ai:east', id: 'ai-job:row', action: 'withdraw', records }, { request_key: 'row-move' });
  assert.equal(moved.result.to, 'withdrawn');
  const work = runRow('tool:see-ai-work', { status: 'waiting', records });
  assert.deepEqual(work.result.jobs.map(one => one.id), ['ai-job:row']);
  const mine = runRow('tool:see-my-ais', { records });
  assert.deepEqual(mine.result.ais.map(one => one.id).sort(), ['ai:east', 'ai:north', 'ai:south']);
  const held = { ...records.at(-1), value: { ...records.at(-1).value, status: 'taken', taker: 'ai:north', taken_at: at(1)().toISOString(), acceptance: acceptance('From a row') } };
  const checked = runRow('tool:finish-an-ai-job', {
    as: 'ai:north', id: held.id, taken_at: held.value.taken_at, result: 'Read the consumer',
    check: { target: held.value.acceptance.target, outcome: held.value.job, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fabricated:claim', observation: 'The claim alone is never sufficient.' }] },
    records: [...AIS.filter(one => one.id !== 'ai:east'), held, { id: 'fixture:destination', type: 'fixture:consumer', value: { readable: true } }],
  });
  assert.equal(checked.result.to, 'done', JSON.stringify(checked));
  assert.match(checked.result.job.check.consumer.identity, /^1f:/, 'the packaged action checked actual consumer bytes');
});

test('the most characters a result takes inline is one number: the rules\' most_chars for the result of finish and of fail is the maxLength the changing tool\'s schema states (the limit trillion finish reads)', () => {
  const change = ROWS.records.map(row => row.payload).find(row => row.id === 'tool:change-an-ai-job');
  const asked = RULES.transitions.filter(row => row.set?.result?.most_chars !== undefined).map(row => row.set.result.most_chars);
  assert.ok(asked.length >= 2, 'finish and fail both bound the result');
  for (const most of asked) assert.equal(change.input_schema.properties.result.maxLength, most);
});

test('a job asks for its outcome, else its job when that is words, else its label', () => {
  assert.equal(requestedOutcome({ outcome: 'Done is this', job: 'Do that', label: 'Name' }), 'Done is this');
  assert.equal(requestedOutcome({ job: 'Do that', label: 'Name' }), 'Do that');
  assert.equal(requestedOutcome({ job: [{ id: 'dig' }], label: 'Name' }), 'Name', 'a job that is a list of steps is not words');
  assert.equal(requestedOutcome({ outcome: '  ', job: [], label: 'Name' }), 'Name');
  assert.equal(requestedOutcome({ job: [] }), undefined);
});

test('two lane jobs of one step, whose job is the step as a list, are each taken, planned and finished by their own taker', async () => {
  const lanes = ['ai:dig-1-lane', 'ai:dig-2-lane'];
  // The shape a lane job has: `job` is the step (a list), the outcome and label are words. The second lane is
  // one written before the outcome was: its label alone says what it asks for.
  const laneJob = (lane, label, outcome) => ({ id: `ai-job:run:dig:${lane.slice(3)}`, type: 'ai-job', value: { kind: 'ai-job', status: 'waiting', label, ...(outcome ? { outcome } : {}), parent: 'ai-job:run', step: 'dig', lane, of: 2, job: [{ id: 'dig', title: 'Dig' }], input: {}, cause: null, priority: 5, sent_at: '2026-11-01T20:00:00.000Z' } });
  const { fake, store } = await account([...AIS, ...lanes.map(lane => ai(lane, { can: ['any'], order: 9 })), ...lanes.map((lane, at1) => laneJob(lane, `Run: Dig, lane ${lane}`, at1 === 0 ? `Run: Dig, lane ${lane}` : null))]);
  try {
    const taken = [];
    for (const [at1, lane] of lanes.entries()) {
      const id = `ai-job:run:dig:${lane.slice(3)}`;
      const took = await takeAJob({ input: { as: lane, id } }, { store: store(), now: at(1 + at1) });
      taken.push({ lane, id, taken_at: took.taken.taken_at });
    }
    for (const { lane, id, taken_at } of taken.reverse()) {
      const outcome = requestedOutcome(job(fake, id));
      const plan = { outcome, target: acceptance(outcome).target, rules: acceptance(outcome).rules };
      await moveAJob({ input: { as: lane, id, taken_at, action: 'plan', acceptance: plan } }, { store: store(), now: at(5) });
      const check = { target: plan.target, outcome, checked_at: at(6)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The destination is readable.' }] };
      const done = await moveAJob({ input: { as: lane, id, taken_at, action: 'finish', result: 'The lane is done', check } }, { store: store(), now: at(6) });
      assert.deepEqual({ moved: done.moved, to: done.to }, { moved: true, to: 'done' }, `${lane} finished its own job though the other lane took a different one`);
    }
    assert.deepEqual(lanes.map(lane => job(fake, `ai-job:run:dig:${lane.slice(3)}`).status), ['done', 'done']);
  } finally { await fake.close(); }
});

test('a finish of a job with no saved acceptance says how its taker saves one, and a launcher-sent job is then finished', async () => {
  const sent = { id: 'ai-job:sent', type: 'ai-job', value: { kind: 'ai-job', status: 'taken', job: 'Land the change', label: 'land', taker: 'ai:north', taken_at: '2026-11-01T20:00:00.000Z', from: 'ai:east', priority: 5, sent_at: '2026-11-01T19:00:00.000Z' } };
  const { fake, store } = await account([...AIS, sent]);
  try {
    const outcome = 'Land the change';
    const check = { target: acceptance(outcome).target, outcome, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The destination is readable.' }] };
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:sent', action: 'finish', result: 'Landed', check } }, { store: store(), now: at(3) }), /trillion plan ID --acceptance-file/);
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:sent', action: 'plan', acceptance: acceptance(outcome) } }, { store: store(), now: at(1) });
    const done = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:sent', action: 'finish', result: 'Landed', check } }, { store: store(), now: at(3) });
    assert.equal(done.to, 'done');
  } finally { await fake.close(); }
});
