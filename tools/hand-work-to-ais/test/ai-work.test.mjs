// The work handed between a person's AIs, against the records door stand-in (tools/records-door/test/fake-door.mjs),
// which checks `expected` the way the engine does: a write whose condition no longer holds is refused whole
// (original_command_conflict) and changes nothing. Made-up AIs and jobs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { handAJob, moveAJob as moveActual, seeAiWork, seeMyAis, takeAJob, workRules } from '../read-data/ai-work.mjs';


// Valid fixture moves carry the take generation. Explicit stale/missing-fence controls call moveActual directly.
async function moveAJob(args, context) {
  const input = { ...args.input };
  const current = await context.door.read('ai-job', input.id);
  if (input.taken_at === undefined && current?.taker === input.as) input.taken_at = current.taken_at;
  return moveActual({ ...args, input }, context);
}
const acceptance = (outcome, parts = []) => ({ outcome, target: { type: 'fixture:consumer', id: 'fixture:destination' }, rules: ['outcome', ...parts].map(id => ({ id, path: 'readable', equals: [true], says: 'The destination must be readable.' })) });

const RULES = JSON.parse(readFileSync(new URL('../read-data/ai-work.json', import.meta.url), 'utf8'));
const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const EVERYTHING = [
  { kind: 'ai', operations: ['records:read', 'records:list'] },
  { kind: 'ai-job', operations: ['records:read', 'records:list', 'records:write'] },
  { kind: 'fixture:consumer', operations: ['records:read'] },
];
const T0 = Date.parse('2026-11-01T20:00:00.000Z');
const at = minutes => () => new Date(T0 + minutes * 60000);
const ai = (id, value) => ({ id, type: 'ai', value: { kind: 'cli', label: id.slice(3), ...value } });
const AIS = [
  ai('ai:north', { can: ['code', 'files'], live: { how: 'heartbeat', minutes: 60, seen_at: '2026-11-01T19:30:00.000Z' }, order: 2 }),
  ai('ai:south', { can: ['any'], live: { how: 'stream', seen_at: '2026-11-01T19:59:00.000Z' }, order: 1 }),
  ai('ai:east', { can: ['write'], live: { how: 'heartbeat', minutes: 60, seen_at: '2026-10-01T00:00:00.000Z' }, order: 3 }),
];

async function account(records = AIS) {
  const fake = await startFakeDoor({ rights: EVERYTHING, records: [...records, { id: 'fixture:destination', type: 'fixture:consumer', value: { readable: true } }] });
  return { fake, door: () => openRecordsDoor({ descriptor: fake.descriptor }) };
}
const job = (fake, id) => fake.kept.get(id)?.value ?? null;

// A door whose writes wait until `count` callers have read, so every caller reads before any writes: the race the
// condition settles, made to happen every time.
function afterAllRead(door, gate) {
  return {
    ...door,
    async read(...args) { const answer = await door.read(...args); gate.read(); return answer; },
    async *list(query) { for await (const record of door.list(query)) yield record; gate.read(); },
    async write(...args) { await gate.all; return door.write(...args); },
  };
}
function gateFor(count) {
  let seen = 0; let open;
  const all = new Promise(done => { open = done; });
  return { all, read() { seen += 1; if (seen >= count) open(); } };
}

test('the shipped rules hold together: states once, no way out of a finished job, every action a row offers', () => {
  const rules = workRules(RULES);
  assert.deepEqual(rules.actions, ['take', 'release', 'finish', 'fail', 'stuck', 'unstuck', 'withdraw', 'wait', 'resume', 'edit', 'plan', 'remove']);
  assert.deepEqual(new Set(rowOf(ROWS, 'tool:change-an-ai-job').input_schema.properties.action.enum), new Set(rules.actions));
  assert.throws(() => workRules({ ...RULES, transitions: [...RULES.transitions, { action: 'reopen', from: 'done', to: 'waiting' }] }), /terminal/);
  assert.throws(() => workRules({ ...RULES, transitions: [{ ...RULES.transitions[0], set: { taker: { from: 'clock' } } }] }), /not as, now, input or note/);
  const models = ROWS.records.flatMap(row => row.payload.record_model?.kinds ?? []).filter(kind => kind.type === 'ai-job');
  assert.equal(models.length, 1, 'the lifecycle owns one canonical replay-metadata declaration');
  assert.deepEqual(models[0].guard_properties, { last_move: 'object', take_request: 'object' });
  for (const id of ['tool:take-an-ai-job', 'tool:change-an-ai-job', 'tool:finish-an-ai-job']) {
    const schema = rowOf(ROWS, id).input_schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties, 'take_request'), false, 'callers cannot supply claim-origin metadata');
  }
  assert.throws(() => workRules({ ...RULES, read_as: { running: 'busy' } }), /not a declared state/);
  assert.throws(() => workRules({ ...RULES, read_as: { done: 'taken' } }), /already a declared state/);
});

test('a job is handed once per key, to a named AI or to any, and an unknown AI is refused', async () => {
  const { fake, door } = await account();
  try {
    const sent = await handAJob({ input: { as: 'ai:north', job: 'Tidy the notes folder', to: 'ai:south', key: 'tidy-1', outcome: 'One folder per month' } }, { door: door(), now: at(0) });
    assert.equal(sent.status, 'written');
    assert.equal(sent.job_id, 'ai-job:tidy-1');
    assert.deepEqual(job(fake, 'ai-job:tidy-1'), { kind: 'ai-job', status: 'waiting', job: 'Tidy the notes folder', to: 'ai:south', from: 'ai:north', priority: 5, sent_at: '2026-11-01T20:00:00.000Z', outcome: 'One folder per month' });
    const again = await handAJob({ input: { as: 'ai:north', job: 'Something else', key: 'tidy-1' } }, { door: door(), now: at(5) });
    assert.equal(again.status, 'already-there');
    assert.equal(again.job.job, 'Tidy the notes folder', 'the job already there is unchanged');
    const anyone = await handAJob({ input: { as: 'ai:north', job: 'Anyone may do this' }, task: { request_key: 'run-7' } }, { door: door(), now: at(1) });
    assert.equal(anyone.job_id, 'ai-job:run-7');
    assert.equal(job(fake, 'ai-job:run-7').to, null);
    const retried = await handAJob({ input: { as: 'ai:north', job: 'Anyone may do this' }, task: { request_key: 'run-7' } }, { door: door(), now: at(1) });
    assert.equal(retried.status, 'written', 'the same run sent again is answered its own receipt');
    assert.equal([...fake.kept.keys()].filter(id => id.startsWith('ai-job:')).length, 2, 'and writes no second job');
    await assert.rejects(handAJob({ input: { as: 'ai:north', job: 'x', to: 'ai:nobody', key: 'k' } }, { door: door() }), /No AI ai:nobody/);
    await assert.rejects(handAJob({ input: { as: 'north', job: 'x', key: 'k' } }, { door: door() }), /record id, ai:/);
    await assert.rejects(handAJob({ input: { as: 'ai:north', job: 'x', key: 'k', priority: 12 } }, { door: door() }), /0 to 9/);
    await assert.rejects(handAJob({ input: { as: 'ai:north', job: 'x', key: 'has space' } }, { door: door() }), /key must be/);
  } finally { await fake.close(); }
});

test('two AIs take the same waiting job at once: exactly one wins, the other is told and changes nothing', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Rename the photos', key: 'race' } }, { door: door(), now: at(0) });
    const gate = gateFor(2);
    const [north, south] = await Promise.all([
      takeAJob({ input: { as: 'ai:north', id: 'ai-job:race' } }, { door: afterAllRead(door(), gate), now: at(1) }),
      takeAJob({ input: { as: 'ai:south', id: 'ai-job:race' } }, { door: afterAllRead(door(), gate), now: at(1) }),
    ]);
    const winners = [north, south].filter(answer => answer.taken);
    const losers = [north, south].filter(answer => !answer.taken);
    assert.equal(winners.length, 1, 'exactly one take wins');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason, 'changed');
    assert.equal(losers[0].job.taker, winners[0].taken.taker, 'the loser sees who has it');
    assert.equal(job(fake, 'ai-job:race').status, 'taken');
    assert.equal(job(fake, 'ai-job:race').taker, winners[0].taken.taker);
    const writes = fake.calls.filter(call => call.method === 'records:write' && call.input.records[0].id === 'ai-job:race');
    assert.equal(writes.length, 3, 'one send and two takes reached the door; the losing take changed nothing');
    assert.deepEqual(writes.slice(1).map(call => call.input.records[0].expected.value.status), ['waiting', 'waiting'], 'both takes were conditioned on the waiting job they read');
  } finally { await fake.close(); }
});

test('two AIs taking the next job at once get different jobs: the loser of the first tries the next', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'First', key: 'one', priority: 7 } }, { door: door(), now: at(0) });
    await handAJob({ input: { as: 'ai:east', job: 'Second', key: 'two' } }, { door: door(), now: at(1) });
    await handAJob({ input: { as: 'ai:east', job: 'For east only', key: 'three', to: 'ai:east', priority: 9 } }, { door: door(), now: at(2) });
    // Each taker lists the stored words of the two states a take leaves from (waiting, and taken or running past the
    // stale time).
    const gate = gateFor(6);
    const [north, south] = await Promise.all([
      takeAJob({ input: { as: 'ai:north' }, task: { request_key: 'n' } }, { door: afterAllRead(door(), gate), now: at(3) }),
      takeAJob({ input: { as: 'ai:south' }, task: { request_key: 's' } }, { door: afterAllRead(door(), gate), now: at(3) }),
    ]);
    assert.deepEqual([north.taken.id, south.taken.id].sort(), ['ai-job:one', 'ai-job:two'], 'priority first, and never the job addressed to another AI');
    assert.deepEqual([north.tried, south.tried].sort(), [1, 2], 'the loser of the first job tried the next one');
    assert.equal(job(fake, 'ai-job:three').status, 'waiting');
    assert.equal((await takeAJob({ input: { as: 'ai:north' } }, { door: door(), now: at(4) })).taken, null, 'nothing left for north');
    assert.equal((await takeAJob({ input: { as: 'ai:east', only_mine: true } }, { door: door(), now: at(4) })).taken.id, 'ai-job:three');
  } finally { await fake.close(); }
});

test('only the taker finishes or fails a job, with a result; anyone may remove it once it is finished', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Count the invoices', key: 'count', acceptance: acceptance('Count the invoices') } }, { door: door(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:count' } }, { door: door(), now: at(1) });
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:count', action: 'finish', result: 'Twelve' } }, { door: door(), now: at(2) }), /does not hold for ai:south/);
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'finish' } }, { door: door(), now: at(2) }), /needs result/);
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'remove' } }, { door: door(), now: at(2) }), /may not remove/);
    const check = { target: acceptance('Count the invoices').target, outcome: 'Count the invoices', checked_at: at(3)().toISOString(), evidence: [{ ref: 'fixture:invoice-count', observation: 'The consumer lists twelve invoices.' }] };
    const done = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'finish', result: 'Twelve invoices', summary: 'Twelve', check } }, { door: door(), now: at(3) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'taken', to: 'done' });
    assert.deepEqual(job(fake, 'ai-job:count'), {
      acceptance: acceptance('Count the invoices'), kind: 'ai-job', status: 'done', job: 'Count the invoices', to: null, from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z',
      taker: 'ai:north', taken_at: '2026-11-01T20:01:00.000Z', check: done.job.check, result: 'Twelve invoices', summary: 'Twelve', finished_at: '2026-11-01T20:03:00.000Z', finished_by: 'ai:north',
    });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'release' } }, { door: door(), now: at(4) }), /cannot be given "release"/);
    const removed = await moveAJob({ input: { as: 'ai:south', id: 'ai-job:count', action: 'remove' } }, { door: door(), now: at(5) });
    assert.deepEqual({ moved: removed.moved, to: removed.to, job: removed.job }, { moved: true, to: null, job: null });
    assert.equal(fake.kept.has('ai-job:count'), false);
    await assert.rejects(seeAiWork({ input: { id: 'ai-job:count' } }, { door: door() }), /No job/);

    await handAJob({ input: { as: 'ai:east', job: 'Try the import', key: 'import' } }, { door: door(), now: at(6) });
    await takeAJob({ input: { as: 'ai:south', id: 'ai-job:import' } }, { door: door(), now: at(7) });
    const failed = await moveAJob({ input: { as: 'ai:south', id: 'ai-job:import', action: 'fail', result: 'The file is empty' } }, { door: door(), now: at(8) });
    assert.equal(failed.to, 'failed');
    assert.equal(job(fake, 'ai-job:import').result, 'The file is empty');
  } finally { await fake.close(); }
});

test('a taker gives a job back or says what blocks it; another AI may give back or take one held past the stale time', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Sort the inbox', key: 'inbox' } }, { door: door(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:inbox' } }, { door: door(), now: at(1) });
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'stuck', words: 'Needs the mail password' } }, { door: door(), now: at(2) });
    assert.deepEqual(job(fake, 'ai-job:inbox').stuck, { by: 'ai:north', at: '2026-11-01T20:02:00.000Z', words: 'Needs the mail password' });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'stuck' } }, { door: door(), now: at(2) }), /needs words/);
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'unstuck' } }, { door: door(), now: at(3) });
    assert.equal('stuck' in job(fake, 'ai-job:inbox'), false);

    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:inbox', action: 'release' } }, { door: door(), now: at(60) }), /does not hold for ai:south/);
    assert.equal((await takeAJob({ input: { as: 'ai:south' } }, { door: door(), now: at(60) })).taken, null, 'a fresh take is not taken over');
    const back = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'release', because: 'Out of time' } }, { door: door(), now: at(61) });
    assert.equal(back.to, 'waiting');
    assert.deepEqual(job(fake, 'ai-job:inbox').released, { by: 'ai:north', at: '2026-11-01T21:01:00.000Z', words: 'Out of time' });
    assert.equal('taker' in job(fake, 'ai-job:inbox'), false);

    const retaken = await takeAJob({ input: { as: 'ai:north' } }, { door: door(), now: at(62) });
    assert.equal(retaken.taken.id, 'ai-job:inbox');
    assert.equal('released' in job(fake, 'ai-job:inbox'), false, 'a new take clears the earlier give-back');
    const stale = 62 + RULES.transitions.find(edge => edge.action === 'take' && edge.from === 'taken').when.rules[1].params.value;
    const takenOver = await takeAJob({ input: { as: 'ai:south' } }, { door: door(), now: at(stale) });
    assert.equal(takenOver.taken.taker, 'ai:south', 'a job held past the stale time may be taken by another AI');
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'release' } }, { door: door(), now: at(stale + 1) }).then(
      () => assert.fail('north no longer holds it'), error => assert.match(error.message, /does not hold for ai:north/));
  } finally { await fake.close(); }
});

test('a watcher may say a running job is stuck, and its taker can still finish it', async () => {
  // A long job written by another writer with the status word "running", which read_as reads as taken.
  const running = { id: 'ai-job:finish:long', type: 'ai-job', value: { kind: 'ai-job', status: 'running', job: 'A long job', to: 'ai:north', from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z', taker: 'ai:north', taken_at: '2026-11-01T20:00:00.000Z', acceptance: acceptance('A long job') } };
  const { fake, door } = await account([...AIS, running]);
  try {
    const flagged = await moveAJob({ input: { as: 'ai:south', id: 'ai-job:finish:long', action: 'stuck', words: 'No change for three hours' } }, { door: door(), now: at(180) });
    assert.deepEqual({ moved: flagged.moved, from: flagged.from }, { moved: true, from: 'running' });
    assert.equal(job(fake, 'ai-job:finish:long').status, 'running', 'a move that stays in the state keeps the stored word');
    assert.deepEqual(job(fake, 'ai-job:finish:long').stuck, { by: 'ai:south', at: '2026-11-01T23:00:00.000Z', words: 'No change for three hours' }, 'the note says who flagged it and when');
    assert.deepEqual((await seeAiWork({ input: { status: 'taken' } }, { door: door() })).jobs.map(one => one.id), ['ai-job:finish:long'], 'a running job lists as taken');
    assert.equal((await seeMyAis({}, { door: door(), now: at(180) })).ais.find(one => one.id === 'ai:north').busy, 1, 'and counts as its taker\'s');
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:finish:long', action: 'finish', result: 'Mine now' } }, { door: door(), now: at(181) }), /does not hold for ai:south/, 'flagging it does not let the watcher finish it');
    const done = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:finish:long', action: 'finish', result: 'Done at last', check: { target: acceptance('A long job').target, outcome: 'A long job', checked_at: at(182)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The consumer is readable.' }] } } }, { door: door(), now: at(182) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'running', to: 'done' });
    assert.equal(job(fake, 'ai-job:finish:long').status, 'done');
    assert.equal('stuck' in job(fake, 'ai-job:finish:long'), false, 'finishing clears the stuck note');
  } finally { await fake.close(); }
});

test('only the sender withdraws a waiting job; a move on a job that changed since it was read writes nothing', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'Book the room', key: 'room' } }, { door: door(), now: at(0) });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:room', action: 'withdraw' } }, { door: door(), now: at(1) }), /does not hold for ai:north/);
    // North reads the job waiting; before its withdraw lands, south takes it.
    const plain = door();
    const meddling = {
      ...plain,
      async write(records, options) {
        await takeAJob({ input: { as: 'ai:south', id: 'ai-job:room' } }, { door: door(), now: at(2) });
        return plain.write(records, options);
      },
    };
    const late = await moveAJob({ input: { as: 'ai:east', id: 'ai-job:room', action: 'withdraw', because: 'Not needed' } }, { door: meddling, now: at(2) });
    assert.deepEqual({ moved: late.moved, reason: late.reason, status: late.job.status, taker: late.job.taker }, { moved: false, reason: 'changed', status: 'taken', taker: 'ai:south' });
    assert.equal(job(fake, 'ai-job:room').status, 'taken', 'the withdraw changed nothing');
    await handAJob({ input: { as: 'ai:east', job: 'Order paper', key: 'paper' } }, { door: door(), now: at(3) });
    const withdrawn = await moveAJob({ input: { as: 'ai:east', id: 'ai-job:paper', action: 'withdraw', because: 'Found some' } }, { door: door(), now: at(4) });
    assert.equal(withdrawn.to, 'withdrawn');
    await assert.rejects(moveAJob({ input: { as: 'ai:east', id: 'ai-job:paper', action: 'take' } }, { door: door(), now: at(5) }), /cannot be given "take"/);
    await assert.rejects(moveAJob({ input: { as: 'ai:east', id: 'ai-job:paper', action: 'reopen' } }, { door: door(), now: at(5) }), /action must be one of/);
  } finally { await fake.close(); }
});

test('my AIs come back live first with what each can do and how many jobs each holds', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', job: 'A', key: 'a' } }, { door: door(), now: at(0) });
    await handAJob({ input: { as: 'ai:east', job: 'B', key: 'b' } }, { door: door(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:a' } }, { door: door(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:b' } }, { door: door(), now: at(0) });
    const { ais } = await seeMyAis({}, { door: door(), now: at(0) });
    assert.deepEqual(ais.map(one => [one.id, one.live, one.busy]), [['ai:south', true, 0], ['ai:north', true, 2], ['ai:east', false, 0]]);
    assert.deepEqual(ais[1].value, AIS[0].value, 'every stored cell comes back as kept; no name is made here');
    assert.deepEqual((await seeMyAis({ input: { can: ['code'] } }, { door: door(), now: at(0) })).ais.map(one => one.id), ['ai:south', 'ai:north']);
    assert.deepEqual((await seeMyAis({ input: { live_only: true } }, { door: door(), now: at(45) })).ais.map(one => one.id), ['ai:south'], 'north was seen 75 minutes before, past its 60');
  } finally { await fake.close(); }
});

test('the work list is newest first, kept to what matches, and says when more matched', async () => {
  const { fake, door } = await account();
  try {
    for (const [minute, key, to] of [[0, 'w1', null], [1, 'w2', 'ai:north'], [2, 'w3', 'ai:north']]) {
      await handAJob({ input: { as: 'ai:east', job: key, key, to } }, { door: door(), now: at(minute) });
    }
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:w2' } }, { door: door(), now: at(3) });
    assert.deepEqual((await seeAiWork({}, { door: door() })).jobs.map(one => one.id), ['ai-job:w3', 'ai-job:w2', 'ai-job:w1']);
    assert.deepEqual((await seeAiWork({ input: { status: 'waiting' } }, { door: door() })).jobs.map(one => one.id), ['ai-job:w3', 'ai-job:w1']);
    assert.deepEqual((await seeAiWork({ input: { to: 'ai:north', limit: 1 } }, { door: door() })), { jobs: [(await seeAiWork({ input: { id: 'ai-job:w3' } }, { door: door() })).jobs[0]], more: true });
    assert.deepEqual((await seeAiWork({ input: { taker: 'ai:north' } }, { door: door() })).jobs.map(one => one.id), ['ai-job:w2']);
    await assert.rejects(seeAiWork({ input: { status: 'lost' } }, { door: door() }), /status must be one of/);
  } finally { await fake.close(); }
});

test('completion retains provenance and checks every requested obligation; text, partial and stale checks stay open', async () => {
  const { fake, door } = await account();
  try {
    const input = { as: 'ai:east', key: 'consumer', job: 'Import the sample', outcome: 'The sample is readable in the destination', acceptance: acceptance('The sample is readable in the destination', ['read']), source: { kind: 'file', ref: 'fixture:sample' }, obligations: [{ id: 'read', outcome: 'The destination returns the sample words' }] };
    await handAJob({ input }, { door: door(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:consumer' } }, { door: door(), now: at(1) });
    const finish = { taken_at: at(1)().toISOString(), as: 'ai:north', id: 'ai-job:consumer', action: 'finish', result: 'Imported the sample' };
    await assert.rejects(moveAJob({ input: finish }, { door: door(), now: at(3) }), /needs check/);
    const check = { target: input.acceptance.target, outcome: input.outcome, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fixture:destination-read', observation: 'The destination returns the sample words.' }] };
    await assert.rejects(moveAJob({ input: { ...finish, check } }, { door: door(), now: at(3) }), /every saved obligation/);
    check.obligations = [{ ...input.obligations[0], evidence: check.evidence }];
    await assert.rejects(moveAJob({ input: { ...finish, check: { ...check, outcome: 'A commit exists' } } }, { door: door(), now: at(3) }), /saved requested outcome/);
    await assert.rejects(moveAJob({ input: { ...finish, check: { ...check, checked_at: at(0)().toISOString() } } }, { door: door(), now: at(3) }), /during this take/);
    assert.equal(job(fake, 'ai-job:consumer').status, 'taken');
    fake.kept.get('fixture:destination').value.readable = false;
    await assert.rejects(moveAJob({ input: { ...finish, check } }, { door: door(), now: at(3) }), /requested outcome is not checked/);
    assert.equal(job(fake, 'ai-job:consumer').status, 'taken', 'fabricated observation text cannot override the actual failed consumer');
    fake.kept.get('fixture:destination').value.readable = true;
    const done = await moveAJob({ input: { ...finish, check }, task: { request_key: 'finish-consumer' } }, { door: door(), now: at(3) });
    assert.equal(done.to, 'done');
    assert.deepEqual(done.job.source, input.source);
    const retry = await moveAJob({ input: { ...finish, check }, task: { request_key: 'finish-consumer' } }, { door: door(), now: at(4) });
    assert.equal(retry.replayed, true);
    await assert.rejects(moveAJob({ input: { ...finish, check, result: 'different' }, task: { request_key: 'finish-consumer' } }, { door: door(), now: at(4) }), /different input/);
    assert.equal([...fake.kept.keys()].filter(key => key.startsWith('ai-job:')).length, 1, 'completion creates no automatic follow-up work');
  } finally { await fake.close(); }
});

test('an old run of the same AI cannot finish a newer take, and an old request receipt cannot fabricate ownership', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'fence', job: 'Check the consumer', acceptance: acceptance('Check the consumer') } }, { door: door(), now: at(0) });
    const first = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:fence' }, task: { request_key: 'old-take' } }, { door: door(), now: at(1) });
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:fence', action: 'release' }, task: { request_key: 'release-fence' } }, { door: door(), now: at(2) });
    const replay = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:fence' }, task: { request_key: 'old-take' } }, { door: door(), now: at(3) });
    assert.equal(replay.taken, null);
    assert.equal(job(fake, 'ai-job:fence').status, 'waiting');
    const second = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:fence' }, task: { request_key: 'new-take' } }, { door: door(), now: at(4) });
    const check = { target: second.taken.acceptance.target, outcome: second.taken.job, checked_at: at(5)().toISOString(), evidence: [{ ref: 'fabricated:ref', observation: 'A fabricated claim of success' }] };
    await assert.rejects(moveActual({ input: { as: 'ai:north', id: 'ai-job:fence', action: 'finish', result: 'Done', check, taken_at: first.taken.taken_at } }, { door: door(), now: at(5) }), /exact current claim/);
    await assert.rejects(moveActual({ input: { as: 'ai:north', id: 'ai-job:fence', action: 'finish', result: 'Done', check } }, { door: door(), now: at(5) }), /exact current claim/);
    assert.equal(job(fake, 'ai-job:fence').taken_at, second.taken.taken_at);
  } finally { await fake.close(); }
});

test('a next-job take replays its original claim before a higher-priority arrival', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'first-claim', job: 'Original work', priority: 5 } }, { door: door(), now: at(0) });
    const request = { input: { as: 'ai:north' }, task: { request_key: 'one-next-job-take' } };
    const first = await takeAJob(request, { door: door(), now: at(1) });
    await handAJob({ input: { as: 'ai:east', key: 'later-priority', job: 'New urgent work', priority: 9 } }, { door: door(), now: at(2) });
    const retry = await takeAJob(request, { door: door(), now: at(3) });
    assert.equal(retry.taken.id, first.taken.id);
    assert.equal(retry.taken.taken_at, first.taken.taken_at);
    await moveAJob({ input: { as: 'ai:north', id: first.taken.id, action: 'stuck', words: 'An observed dependency needs review' }, task: { request_key: 'progress-after-take' } }, { door: door(), now: at(4) });
    const afterNote = await takeAJob(request, { door: door(), now: at(5) });
    assert.equal(afterNote.taken.id, first.taken.id, 'a progress note does not erase the original claim request');
    assert.equal(afterNote.taken.taken_at, first.taken.taken_at);
    assert.equal(job(fake, 'ai-job:later-priority').status, 'waiting');
    assert.deepEqual([...fake.kept.values()].filter(row => row.type === 'ai-job' && row.value.status === 'taken').map(row => row.id), [first.taken.id]);
    await moveAJob({ input: { as: 'ai:north', id: first.taken.id, action: 'release' } }, { door: door(), now: at(6) });
    const afterRelease = await takeAJob(request, { door: door(), now: at(7) });
    assert.equal(afterRelease.taken, null, 'an ended original claim cannot be replayed as ownership or acquire fresh work');
    assert.equal(job(fake, 'ai-job:later-priority').status, 'waiting');
  } finally { await fake.close(); }
});

test('a take replay reads the current claim after listing and refuses a replaced or removed claim', async () => {
  for (const change of ['replaced', 'same-ai-replaced', 'removed']) {
    const { fake, door } = await account();
    try {
      await handAJob({ input: { as: 'ai:east', key: 'read-current', job: 'Original work' } }, { door: door(), now: at(0) });
      const request = { input: { as: 'ai:north' }, task: { request_key: 'replay-current-claim' } };
      const first = await takeAJob(request, { door: door(), now: at(1) });
      await handAJob({ input: { as: 'ai:east', key: 'fresh-current', job: 'Fresh urgent work', priority: 9 } }, { door: door(), now: at(2) });
      const currentDoor = door();
      let changed = false;
      const racingDoor = { ...currentDoor, async read(type, id) {
        if (!changed && id === first.taken.id) {
          changed = true;
          if (change === 'removed') fake.kept.delete(id);
          else fake.kept.get(id).value = { ...job(fake, id), taken_at: at(4)().toISOString(), taker: change === 'same-ai-replaced' ? 'ai:north' : 'ai:south' };
        }
        return currentDoor.read(type, id);
      } };
      const replay = await takeAJob(request, { door: racingDoor, now: at(5) });
      assert.equal(changed, true, 'ownership is re-read after the candidate listing');
      assert.equal(replay.taken, null);
      assert.equal(replay.reason, change === 'removed' ? 'gone' : 'changed');
      assert.equal(job(fake, 'ai-job:fresh-current').status, 'waiting');
    } finally { await fake.close(); }
  }
});

test('a legacy last-move-only take receipt cannot supply the missing original claim fence', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'legacy-replay', job: 'Legacy work' } }, { door: door(), now: at(0) });
    const request = { input: { as: 'ai:north' }, task: { request_key: 'legacy-take-request' } };
    const first = await takeAJob(request, { door: door(), now: at(1) });
    const legacy = job(fake, first.taken.id);
    delete legacy.take_request;
    legacy.taken_at = at(4)().toISOString();
    assert.ok(legacy.last_move.key, 'the legacy receipt retains the matching request but no original take timestamp');
    const replay = await takeAJob(request, { door: door(), now: at(5) });
    assert.equal(replay.taken, null, 'a current same-AI take timestamp cannot fill missing original proof');
    assert.equal(replay.reason, 'changed');
    assert.equal(job(fake, first.taken.id).taken_at, legacy.taken_at);
  } finally { await fake.close(); }
});

test('a taker plans missing acceptance or repeats it unchanged, without replacing saved consumer checks', async () => {
  const { fake, door } = await account();
  try {
    const outcome = 'The destination is readable';
    const saved = acceptance(outcome);
    await handAJob({ input: { as: 'ai:east', key: 'plan-once', job: outcome } }, { door: door(), now: at(0) });
    const first = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:plan-once' } }, { door: door(), now: at(1) });
    const plan = { as: 'ai:north', id: first.taken.id, taken_at: first.taken.taken_at, action: 'plan', acceptance: saved };
    await moveActual({ input: plan, task: { request_key: 'plan-consumer' } }, { door: door(), now: at(2) });
    assert.equal((await moveActual({ input: plan, task: { request_key: 'plan-consumer' } }, { door: door(), now: at(3) })).replayed, true);
    await moveActual({ input: plan, task: { request_key: 'same-plan-new-request' } }, { door: door(), now: at(3) });
    const weaker = { ...saved, rules: [{ id: 'outcome', path: 'readable', equals: [false] }] };
    await assert.rejects(moveActual({ input: { ...plan, acceptance: weaker } }, { door: door(), now: at(4) }), /cannot replace the saved acceptance/);
    assert.deepEqual(job(fake, first.taken.id).acceptance, saved);
    fake.kept.get('fixture:destination').value.readable = false;
    await assert.rejects(moveActual({ input: { as: plan.as, id: plan.id, taken_at: plan.taken_at, action: 'finish', result: 'A claim of completion', check: { target: saved.target, outcome, checked_at: at(5)().toISOString(), evidence: [{ ref: 'fixture:destination', observation: 'The current destination was read' }] } } }, { door: door(), now: at(5) }), /requested outcome is not checked/);
    assert.equal(job(fake, first.taken.id).status, 'taken');

    await handAJob({ input: { as: 'ai:east', key: 'sender-plan', job: outcome, acceptance: saved } }, { door: door(), now: at(0) });
    const second = await takeAJob({ input: { as: 'ai:north', id: 'ai-job:sender-plan' } }, { door: door(), now: at(1) });
    await assert.rejects(moveActual({ input: { ...plan, id: second.taken.id, taken_at: second.taken.taken_at, acceptance: weaker } }, { door: door(), now: at(4) }), /cannot replace the saved acceptance/);
    assert.deepEqual(job(fake, second.taken.id).acceptance, saved);
  } finally { await fake.close(); }
});

test('the sender edits waiting work in the shared action owner; unrelated callers cannot change its acceptance', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'edit', job: 'Check the consumer' } }, { door: door(), now: at(0) });
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:edit', action: 'edit', acceptance: acceptance('Check the consumer') } }, { door: door(), now: at(1) }), /does not hold/);
    await moveAJob({ input: { as: 'ai:east', id: 'ai-job:edit', action: 'edit', acceptance: acceptance('Check the consumer'), to: null } }, { door: door(), now: at(1) });
    assert.deepEqual(job(fake, 'ai-job:edit').acceptance, acceptance('Check the consumer'));
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:edit' } }, { door: door(), now: at(2) });
    await assert.rejects(moveAJob({ input: { as: 'ai:east', id: 'ai-job:edit', action: 'edit', outcome: 'A weaker goal' } }, { door: door(), now: at(3) }), /cannot be given/);
  } finally { await fake.close(); }
});

test('an owned bounded recovery resumes the same job; early and unrelated callers cannot wake it', async () => {
  const { fake, door } = await account();
  try {
    await handAJob({ input: { as: 'ai:east', key: 'recover', job: 'Read the destination' } }, { door: door(), now: at(0) });
    const take = { input: { as: 'ai:north', id: 'ai-job:recover' }, task: { request_key: 'take-recover' } };
    await takeAJob(take, { door: door(), now: at(1) });
    assert.equal((await takeAJob(take, { door: door(), now: at(2) })).taken.taker, 'ai:north', 'same take replay does not need stale takeover');
    const continuation = { owner: 'ai:south', action: 'Retry the destination read', after: at(10)().toISOString(), reason: 'The destination returned a temporary unavailable response' };
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:recover', action: 'wait', continuation } }, { door: door(), now: at(3) });
    assert.equal(job(fake, 'ai-job:recover').status, 'blocked');
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:recover', action: 'resume', because: 'The dependency was checked and is available again' } }, { door: door(), now: at(9) }), /does not hold/);
    await assert.rejects(moveAJob({ input: { as: 'ai:unrelated', id: 'ai-job:recover', action: 'resume', because: 'The dependency was checked and is available again' } }, { door: door(), now: at(10) }), /does not hold/);
    await moveAJob({ input: { as: 'ai:south', id: 'ai-job:recover', action: 'resume', because: 'The dependency was checked and is available again' } }, { door: door(), now: at(10) });
    assert.equal((await takeAJob({ input: { as: 'ai:south', id: 'ai-job:recover' } }, { door: door(), now: at(10) })).taken.taker, 'ai:south');
    await moveAJob({ input: { as: 'ai:south', id: 'ai-job:recover', action: 'release', continuation: { ...continuation, after: at(20)().toISOString() } } }, { door: door(), now: at(11) });
    assert.equal((await takeAJob({ input: { as: 'ai:south' } }, { door: door(), now: at(12) })).taken, null, 'bounded release does not spin immediately');
    assert.equal([...fake.kept.keys()].filter(key => key.startsWith('ai-job:')).length, 1);
  } finally { await fake.close(); }
});

test('each row runs as the container runs it, with exactly its own rights at the door', async () => {
  const records = [...AIS, { id: 'ai-job:row', type: 'ai-job', value: { kind: 'ai-job', status: 'waiting', job: 'From a row', to: null, from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z' } }];
  const sent = await answerOf(rowOf(ROWS, 'tool:hand-a-job-to-an-ai'), { as: 'ai:east', job: 'Water the plants', to: 'ai:north' }, { records, task: { request_key: 'row-send' } });
  assert.equal(sent.status, 0, JSON.stringify(sent));
  assert.equal(sent.result.job_id, 'ai-job:row-send');
  const taken = await answerOf(rowOf(ROWS, 'tool:take-an-ai-job'), { as: 'ai:north' }, { records, task: { request_key: 'row-take' } });
  assert.equal(taken.result.taken.id, 'ai-job:row');
  assert.equal(taken.kept.find(record => record.id === 'ai-job:row').value.taker, 'ai:north');
  const moved = await answerOf(rowOf(ROWS, 'tool:change-an-ai-job'), { as: 'ai:east', id: 'ai-job:row', action: 'withdraw' }, { records, task: { request_key: 'row-move' } });
  assert.equal(moved.result.to, 'withdrawn');
  const work = await answerOf(rowOf(ROWS, 'tool:see-ai-work'), { status: 'waiting' }, { records });
  assert.deepEqual(work.result.jobs.map(one => one.id), ['ai-job:row']);
  const mine = await answerOf(rowOf(ROWS, 'tool:see-my-ais'), {}, { records });
  assert.deepEqual(mine.result.ais.map(one => one.id).sort(), ['ai:east', 'ai:north', 'ai:south']);
  const held = { ...records.at(-1), value: { ...records.at(-1).value, status: 'taken', taker: 'ai:north', taken_at: at(1)().toISOString(), acceptance: acceptance('From a row') } };
  const checked = await answerOf(rowOf(ROWS, 'tool:finish-an-ai-job'), {
    as: 'ai:north', id: held.id, taken_at: held.value.taken_at, result: 'Read the consumer',
    check: { target: held.value.acceptance.target, outcome: held.value.job, checked_at: at(2)().toISOString(), evidence: [{ ref: 'fabricated:claim', observation: 'The claim alone is never sufficient.' }] },
  }, { records: [...AIS, held, { id: 'fixture:destination', type: 'fixture:consumer', value: { readable: true } }] });
  assert.equal(checked.status, 0, JSON.stringify(checked));
  assert.equal(checked.result.to, 'done');
  assert.match(checked.result.job.check.consumer.identity, /^1f:/, 'the packaged action checked actual persisted consumer bytes');
});

test('the most characters a result takes inline is one number: the rules\' most_chars for the result of finish and of fail is the maxLength the changing tool\'s schema states (the door\'s own limit, which trillion finish reads)', () => {
  const change = ROWS.records.map(row => row.payload).find(row => row.id === 'tool:change-an-ai-job');
  const asked = RULES.transitions.filter(row => row.set?.result?.most_chars !== undefined).map(row => row.set.result.most_chars);
  assert.ok(asked.length >= 2, 'finish and fail both bound the result');
  for (const most of asked) assert.equal(change.input_schema.properties.result.maxLength, most);
});
