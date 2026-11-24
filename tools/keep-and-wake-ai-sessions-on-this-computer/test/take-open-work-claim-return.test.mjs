// RWF-06's claim-first return fixture. All records, child processes and tool calls are synthetic. Production task moves
// decide rights and acceptance, and the taker decides when to start and finish; the fixture's store only applies their CAS.
// No account transport, AI login or real child process is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultFileOf, runPass, taskCaller, takerCard } from '../harness/take-open-work.mjs';
import { takeATask, changeATask } from '../../plan-tasks-and-todo-lists/task-moves.mjs';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import base from '../harness/take-open-work.json' with { type: 'json' };

const NOW = '2026-11-24T08:00:00.000Z';
const LATER = '2026-11-24T08:01:00.000Z';
const SUBMIT = { type: 'object', required: ['word'], properties: { word: { type: 'string', enum: ['ready'] } }, additionalProperties: false };

function fixture({ afterStart, afterFinalRead, beforeAnswerWrite, missingFence = false } = {}) {
  const settings = { ...base, use_ai: 'codex', ai_order: ['codex'], computer_name: 'Claim Return Fixture', max_concurrent: 1,
    ais: [{ id: 'codex', label: 'Synthetic Codex', command: ['/synthetic/codex', 'exec', '{prompt}'] }], ai_auth: {},
    state_folder: tempFolder(join(tmpdir(), 'rwf06-claim-return-')), working_folder: tmpdir(), triage: undefined, work_mcp: undefined,
    tasks: { ...base.tasks, recovery_after_seconds: 0 } };
  const me = `${settings.tasks.ai_kind}:${takerCard(settings, 'Fixture').agent_id}`;
  const id = `${settings.tasks.kind}:synthetic-claim-return`;
  const held = new Map([[id, { type: settings.tasks.kind, value: { id, title: 'Answer ready', description: 'Answer ready',
    status: 'To do', assignees: [me], priority: 'medium', sent_by: 'ai:synthetic-sender', sent_at: NOW,
    asks: { do: 'Answer with the word ready.', submit: SUBMIT, checks: [] } } }],
  [me, { type: settings.tasks.ai_kind, value: { name: 'Synthetic taker' } }],
  ['ai:other', { type: 'ai', value: { name: 'Other synthetic taker' } }]]);
  const calls = [], receipts = new Map();
  let childClosed = false, readRace = false, writeRace = false;
  const current = () => held.get(id).value;
  const clone = value => structuredClone(value);
  const write = (rows, key) => {
    if (key && receipts.has(key)) return;
    for (const row of rows) {
      const prior = held.get(row.id) ?? null;
      const expected = row.expected ?? null;
      const matches = expected === null ? prior === null : prior?.type === expected.type && JSON.stringify(prior.value) === JSON.stringify(expected.value);
      if (!matches) throw Object.assign(new Error('The record changed'), { code: 'original_command_conflict' });
    }
    for (const row of rows) {
      if (row.value === null) held.delete(row.id);
      else held.set(row.id, clone({ type: row.type, value: row.value }));
    }
    if (key) receipts.set(key, true);
  };
  const resource = async (address, method, input, key) => {
    calls.push({ address, method, input: clone(input), key });
    if (method === 'records:read') return clone(held.get(input.id)?.value ?? null);
    if (method === 'records:list') return { records: [...held].filter(([, row]) => row.type === input.type
      && Object.entries(input.where ?? {}).every(([field, value]) => row.value[field] === value))
      .map(([recordId, row]) => ({ id: recordId, value: clone(row.value) })), next: null };
    if (method === 'records:write') {
      if (beforeAnswerWrite && !writeRace && input.records.some(row => row.id === id && row.value?.answer?.word === 'ready')) {
        writeRace = true;
        beforeAnswerWrite(current(), me);
      }
      write(input.records, key);
      return { written: input.records.length };
    }
    if (method === 'tools:run') {
      const receipt = `tool:${key}`;
      if (receipts.has(receipt)) return clone(receipts.get(receipt));
      assert.ok([settings.tasks.take_tool, settings.tasks.move_tool, settings.tasks.finish_tool].includes(input.tool), 'no undeclared tool runs');
      const action = input.tool === settings.tasks.take_tool ? takeATask : changeATask;
      const given = input.tool === settings.tasks.finish_tool ? { ...input.input, action: 'finish' } : input.input;
      const result = await action({ input: given, task: { request_key: key } }, { now: () => new Date(NOW) });
      const reply = { exit_code: 0, result };
      receipts.set(receipt, clone(reply));
      return reply;
    }
    throw new Error(`Unexpected synthetic operation ${address} ${method}`);
  };
  const raw = Object.assign(async () => { throw new Error('No real or legacy account transport is allowed'); }, { resource });
  const call = taskCaller(raw, settings, { now: () => new Date(NOW), computer: 'Fixture' });
  const worker = async (path, body) => {
    const reply = await call(path, body);
    if (path === '/handoffs/take' && missingFence && reply.handoff) delete reply.handoff.taken_at;
    if (path === '/handoffs/read' && childClosed && afterFinalRead && !readRace) {
      readRace = true;
      afterFinalRead(current(), me);
    }
    return reply;
  };
  worker.tasks = true;
  worker.resource = call.resource;
  let starts = 0;
  const spawnRun = () => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = process.pid;
    child.kill = () => { throw new Error('No real process may be stopped in this fixture'); };
    setImmediate(() => {
      const result = resultFileOf(settings, id);
      mkdirSync(join(result, '..'), { recursive: true });
      writeFileSync(result, JSON.stringify({ result: { word: 'ready' }, evidence: 'The synthetic child answered ready.' }));
      afterStart?.(current(), me);
      childClosed = true;
      child.emit('close', 0);
    });
    return child;
  };
  const pass = () => runPass({ settings, call: worker, computer: 'Fixture', now: () => new Date(NOW), spawnRun,
    locate: () => '/synthetic/codex', checkConnection: () => { throw new Error('No account preflight is used'); } });
  const toolCalls = tool => calls.filter(row => row.method === 'tools:run' && row.input.tool === tool);
  return { id, me, settings, calls, current, pass, call, toolCalls, starts: () => starts };
}

test('a claim-first synthetic Codex result reaches canonical checked Done, and another pass starts nothing', async () => {
  const f = fixture();
  const pass = await f.pass();
  assert.deepEqual(pass.started, [f.id]);
  const [result] = await Promise.all(pass.runs);
  assert.equal(result.finished, true);
  assert.equal(f.current().status, 'Done');
  assert.deepEqual(f.current().answer, { word: 'ready' });
  assert.equal(f.current().result, JSON.stringify({ word: 'ready' }));
  assert.equal(f.current().finished_by, f.me);
  assert.equal(f.current().check.taken_at, f.current().taken_at);
  assert.equal(f.toolCalls(f.settings.tasks.finish_tool).length, 1);
  const again = await f.pass();
  await Promise.all(again.runs);
  assert.deepEqual(again.started, []);
  assert.equal(f.starts(), 1);
  assert.equal(f.toolCalls(f.settings.tasks.finish_tool).length, 1, 'no duplicate finish after the checked terminal state');
});

for (const [name, replacement] of [['another taker', 'ai:other'], ['a newer claim of the same taker', null]]) {
  test(`a child from an ended claim cannot write its answer onto ${name}`, async () => {
    const f = fixture({ afterStart: (task, me) => {
      task.taken_by = replacement ?? me;
      task.taken_at = LATER;
      task.answer = { word: 'newer-owner-answer' };
    } });
    const pass = await f.pass();
    const [result] = await Promise.all(pass.runs);
    assert.equal(result.finished, false);
    assert.equal(f.current().status, 'In progress');
    assert.equal(f.current().taken_at, LATER);
    assert.deepEqual(f.current().answer, { word: 'newer-owner-answer' }, 'the newer holder owns the answer as well as the final move');
    assert.equal(f.toolCalls(f.settings.tasks.finish_tool).length, 0, 'no finish of another claim is attempted');
  });
}

test('a take reply with no original fence never writes an answer onto a claim read afterwards', async () => {
  const f = fixture({ missingFence: true });
  const pass = await f.pass();
  const [result] = await Promise.all(pass.runs);
  assert.equal(result.finished, false);
  assert.equal(f.current().status, 'In progress');
  assert.equal(f.current().answer, undefined);
  assert.equal(f.toolCalls(f.settings.tasks.finish_tool).length, 0);
});

for (const [name, replacement] of [['another taker', 'ai:other'], ['the same taker', null]]) {
  test(`a claim replaced after the final read by ${name} is checked again before the answer write`, async () => {
    const f = fixture({ afterFinalRead: (task, me) => {
      task.taken_by = replacement ?? me;
      task.taken_at = LATER;
      task.answer = { word: 'newer-owner-answer' };
    } });
    const pass = await f.pass();
    const [result] = await Promise.all(pass.runs);
    assert.equal(result.finished, false);
    assert.equal(f.current().status, 'In progress');
    assert.equal(f.current().taken_at, LATER);
    assert.deepEqual(f.current().answer, { word: 'newer-owner-answer' });
    assert.equal(f.toolCalls(f.settings.tasks.finish_tool).length, 0);
  });
}

test('a claim replaced after the answer read is protected by the store conditional write', async () => {
  const f = fixture({ beforeAnswerWrite: (task, me) => {
    task.taken_by = me;
    task.taken_at = LATER;
    task.answer = { word: 'newer-owner-answer' };
  } });
  const pass = await f.pass();
  const [result] = await Promise.all(pass.runs);
  assert.equal(result.finished, false);
  assert.equal(f.current().status, 'In progress');
  assert.deepEqual(f.current().answer, { word: 'newer-owner-answer' });
  assert.equal(f.toolCalls(f.settings.tasks.finish_tool).length, 0);
});

test('two absent fences never count as the same original claim', async () => {
  const f = fixture({ missingFence: true, afterStart: task => { delete task.taken_at; } });
  const pass = await f.pass();
  const [result] = await Promise.all(pass.runs);
  assert.equal(result.finished, false);
  assert.equal(f.current().status, 'In progress');
  assert.equal(f.current().answer, undefined);
});

test('a completed task cannot have its checked answer changed by a late duplicate return', async () => {
  const f = fixture();
  await Promise.all((await f.pass()).runs);
  const completed = structuredClone(f.current());
  await assert.rejects(f.call('/handoffs/answer', { handoff_id: f.id, agent_id: f.me, taken_at: completed.taken_at,
    answer: { word: 'late duplicate' } }), /exact run/);
  assert.deepEqual(f.current(), completed);
});

for (const [name, actor] of [['absent', undefined], ['null', null], ['empty', ''], ['whitespace-only', '   '],
  ['a number', 0], ['a boolean', false], ['an object', {}], ['an array', []]]) {
  test(`the answer adapter rejects matching actors that are ${name} before any write`, async () => {
    const f = fixture();
    const task = f.current();
    task.status = 'In progress';
    task.taken_at = NOW;
    const body = { handoff_id: f.id, taken_at: NOW, answer: { word: 'ready' } };
    if (actor === undefined) delete task.taken_by;
    else { task.taken_by = actor; body.agent_id = actor; }
    const before = structuredClone(task);
    await assert.rejects(f.call('/handoffs/answer', body), /exact run/);
    assert.deepEqual(f.current(), before, 'missing actor fences cannot become an answer mutation');
    assert.equal(f.calls.filter(row => row.method === 'records:write').length, 0);
  });
}

test('the answer adapter never borrows a valid actor from the current claim', async () => {
  const f = fixture();
  Object.assign(f.current(), { status: 'In progress', taken_by: f.me, taken_at: NOW });
  const before = structuredClone(f.current());
  await assert.rejects(f.call('/handoffs/answer', { handoff_id: f.id, taken_at: NOW, answer: { word: 'ready' } }), /exact run/);
  assert.deepEqual(f.current(), before);
  assert.equal(f.calls.filter(row => row.method === 'records:write').length, 0);
});
