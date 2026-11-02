// The work handed between a person's AIs, against the records door stand-in (tools/records-door/test/fake-door.mjs),
// which checks `expected` the way the engine does: a write whose condition no longer holds is refused whole
// (original_command_conflict) and changes nothing. Made-up AIs and jobs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';
import { handAJob, moveAJob, seeAiWork, seeMyAis, takeAJob, workRules } from '../read-data/ai-work.mjs';

const RULES = JSON.parse(readFileSync(new URL('../read-data/ai-work.json', import.meta.url), 'utf8'));
const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const EVERYTHING = [
  { kind: 'ai', operations: ['records:read', 'records:list'] },
  { kind: 'ai-job', operations: ['records:read', 'records:list', 'records:write'] },
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
  const fake = await startFakeDoor({ rights: EVERYTHING, records });
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
  assert.deepEqual(rules.actions, ['take', 'release', 'finish', 'fail', 'stuck', 'unstuck', 'withdraw', 'remove']);
  assert.deepEqual(rowOf(ROWS, 'tool:change-an-ai-job').input_schema.properties.action.enum, rules.actions);
  assert.throws(() => workRules({ ...RULES, transitions: [...RULES.transitions, { action: 'reopen', from: 'done', to: 'waiting' }] }), /terminal/);
  assert.throws(() => workRules({ ...RULES, transitions: [{ ...RULES.transitions[0], set: { taker: { from: 'clock' } } }] }), /not as, now, input or note/);
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
    // Each taker lists the two statuses a take leaves from (waiting, and taken past the stale time).
    const gate = gateFor(4);
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
    await handAJob({ input: { as: 'ai:east', job: 'Count the invoices', key: 'count' } }, { door: door(), now: at(0) });
    await takeAJob({ input: { as: 'ai:north', id: 'ai-job:count' } }, { door: door(), now: at(1) });
    await assert.rejects(moveAJob({ input: { as: 'ai:south', id: 'ai-job:count', action: 'finish', result: 'Twelve' } }, { door: door(), now: at(2) }), /does not hold for ai:south/);
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'finish' } }, { door: door(), now: at(2) }), /needs result/);
    await assert.rejects(moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'remove' } }, { door: door(), now: at(2) }), /may not remove/);
    const done = await moveAJob({ input: { as: 'ai:north', id: 'ai-job:count', action: 'finish', result: 'Twelve invoices', summary: 'Twelve' } }, { door: door(), now: at(3) });
    assert.deepEqual({ moved: done.moved, from: done.from, to: done.to }, { moved: true, from: 'taken', to: 'done' });
    assert.deepEqual(job(fake, 'ai-job:count'), {
      kind: 'ai-job', status: 'done', job: 'Count the invoices', to: null, from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z',
      taker: 'ai:north', taken_at: '2026-11-01T20:01:00.000Z', result: 'Twelve invoices', summary: 'Twelve', finished_at: '2026-11-01T20:03:00.000Z', finished_by: 'ai:north',
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
    const stale = 62 + RULES.transitions.find(edge => edge.action === 'take' && edge.from === 'taken').when.all[1].at_least.value;
    const takenOver = await takeAJob({ input: { as: 'ai:south' } }, { door: door(), now: at(stale) });
    assert.equal(takenOver.taken.taker, 'ai:south', 'a job held past the stale time may be taken by another AI');
    await moveAJob({ input: { as: 'ai:north', id: 'ai-job:inbox', action: 'release' } }, { door: door(), now: at(stale + 1) }).then(
      () => assert.fail('north no longer holds it'), error => assert.match(error.message, /does not hold for ai:north/));
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

test('each row runs as the container runs it, with exactly its own rights at the door', async () => {
  const records = [...AIS, { id: 'ai-job:row', type: 'ai-job', value: { kind: 'ai-job', status: 'waiting', job: 'From a row', to: null, from: 'ai:east', priority: 5, sent_at: '2026-11-01T20:00:00.000Z' } }];
  const sent = await runRow(rowOf(ROWS, 'tool:hand-a-job-to-an-ai'), { input: { as: 'ai:east', job: 'Water the plants', to: 'ai:north' }, task: { request_key: 'row-send' } }, { records });
  assert.equal(sent.status, 0, JSON.stringify(sent));
  assert.equal(sent.result.job_id, 'ai-job:row-send');
  const taken = await runRow(rowOf(ROWS, 'tool:take-an-ai-job'), { input: { as: 'ai:north' }, task: { request_key: 'row-take' } }, { records });
  assert.equal(taken.result.taken.id, 'ai-job:row');
  assert.equal(taken.kept.find(record => record.id === 'ai-job:row').value.taker, 'ai:north');
  const moved = await runRow(rowOf(ROWS, 'tool:change-an-ai-job'), { input: { as: 'ai:east', id: 'ai-job:row', action: 'withdraw' }, task: { request_key: 'row-move' } }, { records });
  assert.equal(moved.result.to, 'withdrawn');
  const work = await runRow(rowOf(ROWS, 'tool:see-ai-work'), { input: { status: 'waiting' }, task: {} }, { records });
  assert.deepEqual(work.result.jobs.map(one => one.id), ['ai-job:row']);
  const mine = await runRow(rowOf(ROWS, 'tool:see-my-ais'), { input: {}, task: {} }, { records });
  assert.deepEqual(mine.result.ais.map(one => one.id).sort(), ['ai:east', 'ai:north', 'ai:south']);
});
