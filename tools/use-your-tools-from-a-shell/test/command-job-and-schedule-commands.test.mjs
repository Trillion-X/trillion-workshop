import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import settings from '../do-work/command.json' with { type: 'json' };
import { CommandError, argumentsFor, schedules, validateAcceptance, validateCheck, validateContinuation, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const me = { agent_id: 'lane-a', ai_id: 'ai:lane-a', held_as: [] };
const folder = mkdtempSync(join(tmpdir(), 'example-job-commands-'));
const file = (name, value) => { const path = join(folder, name); writeFileSync(path, JSON.stringify(value)); return path; };
const call = (command, words, flags = {}) => argumentsFor(command, { words, flags }, { me, requestKey: 'key-1' });
const continuation = { owner: 'ai:lane-b', action: 'Read the consumer record', after: '2026-11-17T09:00:00-06:00', reason: 'Waiting on the sender' };
const acceptance = { outcome: 'Saved', target: { type: 'note', id: 'note:1' }, rules: [{ id: 'outcome', path: 'text', equals: ['x'] }] };

const task = 'record:calendar-task:1';
test('wait, resume, edit and release carry their saved parts, and a malformed part is refused before anything is sent', () => {
  assert.deepEqual(call('wait', [task], { 'continuation-file': file('c.json', continuation) }).input, { as: 'ai:lane-a', id: task, action: 'wait', continuation });
  assert.deepEqual(call('release', [task], { because: 'later', 'continuation-file': file('c2.json', continuation) }).input, { as: 'ai:lane-a', id: task, action: 'release', because: 'later', continuation });
  assert.deepEqual(call('resume', [task], { because: 'The record changed' }).input, { as: 'ai:lane-a', id: task, action: 'resume', because: 'The record changed' });
  assert.throws(() => call('resume', [task]), /Say what changed/);
  assert.throws(() => call('wait', [task]), /continuation-file/);
  assert.throws(() => call('wait', [task], { 'continuation-file': file('bad.json', { owner: 'lane-b' }) }), /A continuation needs owner ai:NAME/);
  const edit = call('edit', [task], { description: 'Do it again', to: 'person:someone', priority: 'high', 'obligations-file': file('o.json', [{ id: 'a', outcome: 'A holds' }]), 'source-file': file('s.json', { kind: 'repository', ref: 'r' }) });
  assert.deepEqual(edit.input, { as: 'ai:lane-a', id: task, action: 'edit', description: 'Do it again', source: { kind: 'repository', ref: 'r' }, obligations: [{ id: 'a', outcome: 'A holds' }], assignees: ['person:someone'], priority: 'high' });
  assert.deepEqual(edit.read.ids, [{ type: 'person', id: 'person:someone' }], 'the person it is handed to is read with the move');
  assert.throws(() => call('edit', [task]), /Name at least one field/);
  assert.throws(() => call('edit', [task], { to: 'someone' }), /record id/, 'a hand-on names a record id, never a bare name');
  assert.throws(() => call('edit', [task], { 'obligations-file': file('dup.json', [{ id: 'a', outcome: 'x' }, { id: 'a', outcome: 'y' }]) }), /Obligations are unique rows/);
  for (const action of ['wait', 'resume', 'edit', 'hand-on']) assert.equal(settings.tasks.actions[action], action, `${action} is a task action`);
});

test('give carries a saved acceptance, source and obligations, and the outcome must match the acceptance', () => {
  const given = call('give', ['Save', 'a', 'note'], { 'acceptance-file': file('a.json', acceptance) }).input;
  assert.deepEqual([given.outcome, given.acceptance], ['Saved', acceptance]);
  assert.throws(() => call('give', ['Save'], { 'acceptance-file': file('a2.json', acceptance), outcome: 'Other' }), /must exactly match/);
  assert.throws(() => call('plan', [task], { 'acceptance-file': file('a3.json', { outcome: 'x' }) }), /Acceptance needs outcome/);
});

test('a check receipt is valid only with an outcome, an offset time, evidence and obligations', () => {
  const receipt = { outcome: 'Saved', checked_at: '2026-11-16T20:05:00Z', evidence: [{ ref: 'note:1', observation: 'Read back.' }], obligations: [] };
  assert.equal(validateCheck(receipt), receipt);
  for (const broken of [{ ...receipt, checked_at: '2026-11-16' }, { ...receipt, evidence: [] }, { ...receipt, obligations: undefined }]) assert.throws(() => validateCheck(broken), CommandError);
  assert.equal(validateContinuation(continuation), continuation);
  assert.equal(validateAcceptance(acceptance), acceptance);
});

// A fake engine for the schedule commands: the wakes the tool rows declare, the live causes, and every call sent.
const engine = () => {
  const wakes = [{ tool: 'tool:x', id: 'daily', on: { time: { every_ms: 86400000 } }, switched_on: true }], live = {}, calls = [];
  const client = {
    wait: async () => {},
    op: async (address, method, input, options = {}) => {
      calls.push({ address, method, input, key: options.requestKey ?? null });
      if (method === 'wake:list') return { wakes };
      if (method === 'wake:switch') {
        const wake = wakes.find(row => row.tool === input.tool && row.id === input.id);
        if (!wake) throw new CommandError(`No wake ${input.id} of ${input.tool}.`, { status: 4 });
        wake.switched_on = input.on;
        return { on: input.on };
      }
      if (method === 'tools:cancel') { const was = Object.hasOwn(live, input.run); delete live[input.run]; return { cancelled: was }; }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client, wakes, live, calls };
};
const run2 = (fake, words, options) => schedules(fake.client, words, { requestKey: 'req-1', rules: settings, ...options });
const run = (fake, ...words) => schedules(fake.client, words, { requestKey: 'req-1', rules: settings });

test('schedule lists the declared wakes and switches one off and on at the wake owner, naming no address and no row', async () => {
  const fake = engine();
  assert.deepEqual((await run(fake, 'list')).wakes.map(wake => [wake.tool, wake.id, wake.switched_on]), [['tool:x', 'daily', true]]);
  assert.deepEqual((await run(fake)).wakes.length, 1, 'no words lists them');
  assert.deepEqual(await run(fake, 'off', 'tool:x', 'daily'), { on: false });
  assert.equal(fake.wakes[0].switched_on, false);
  assert.deepEqual(await run(fake, 'on', 'tool:x', 'daily'), { on: true });
  assert.deepEqual(fake.calls.map(call => [call.address, call.method]), [[null, 'wake:list'], [null, 'wake:list'], [null, 'wake:switch'], [null, 'wake:switch']]);
  assert.deepEqual(fake.calls.filter(call => call.method === 'wake:switch').map(call => call.key), ['req-1', 'req-1']);
  await assert.rejects(run(fake, 'off', 'tool:x', 'weekly'), /No wake weekly/);
});

test('schedule refuses words it does not take, before anything is sent', async () => {
  const fake = engine();
  await assert.rejects(run(fake, 'on', 'tool:x'), /Name the wake id/);
  await assert.rejects(run(fake, 'off'), /Name the tool/);
  await assert.rejects(run(fake, 'list', 'extra'), /schedule list/);
  await assert.rejects(run(fake, 'cancel'), /admitted run key/);
  for (const gone of ['at', 'repeat', 'edit', 'delete', 'read']) await assert.rejects(run(fake, gone, 'schedule:1'), /Unknown schedule command/);
  assert.equal(fake.calls.length, 0);
});

test('schedule cancel asks the engine to cancel one exact admitted run under the request key', async () => {
  const fake = engine();
  fake.live['run-1'] = { tool: 'tool:x', wake: 'daily' };
  assert.deepEqual(await run(fake, 'cancel', 'run-1'), { cancelled: true });
  assert.deepEqual(fake.calls.map(call => [call.method, call.input, call.key]), [['tools:cancel', { run: 'run-1' }, 'req-1']]);
});

// A wake switch's own input: sent whole, refused in words before any call when it cannot be one, never resent without.
test('schedule on --input sends the object with the switch and never prints its values', async () => {
  const fake = engine();
  const input = { vault: 'my-secret-name', rules: ['a', 'b'] };
  assert.deepEqual(await run2(fake, ['on', 'tool:x', 'daily'], { inputFile: 'f.json', readInput: () => JSON.stringify(input) }), { on: true });
  assert.deepEqual(fake.calls.map(call => [call.method, call.input]), [['wake:switch', { tool: 'tool:x', id: 'daily', on: true, input }]]);
});

test('schedule on --input refuses a non-object, an over-size object and off with input, before anything is sent', async () => {
  const fake = engine();
  for (const text of ['[1]', '"x"', '7', 'null', 'not json']) {
    const error = await run2(fake, ['on', 'tool:x', 'daily'], { inputFile: 'f', readInput: () => text }).catch(refused => refused);
    assert.match(error.message, /one saved object/);
    assert.ok(!error.message.includes('not json'));
  }
  await assert.rejects(run2(fake, ['on', 'tool:x', 'daily'], { inputFile: 'f', readInput: () => JSON.stringify({ big: 'x'.repeat(65536) }) }), /at most 65536 bytes/);
  await assert.rejects(run2(fake, ['off', 'tool:x', 'daily'], { inputFile: 'f', readInput: () => '{}' }), /only with schedule on/);
  await assert.rejects(run2(fake, ['on', 'tool:x', 'daily'], { inputFile: 'f', readInput: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } }), /Could not read --input f: ENOENT/);
  assert.equal(fake.calls.length, 0);
});

test('an engine older than the input refuses the field: the refusal passes through with one hint and is not resent', async () => {
  const calls = [];
  const refusal = settings.engine.need_refusal;
  const client = { wait: async () => {}, op: async (address, method, input) => { calls.push(input); throw new CommandError(refusal.message, { answer: { code: refusal.code, message: refusal.message } }); } };
  const error = await schedules(client, ['on', 'tool:x', 'daily'], { requestKey: 'req-1', rules: settings, inputFile: 'f', readInput: () => '{"a":1}' }).catch(refused => refused);
  assert.equal(error.answer.code, refusal.code);
  assert.ok(error.message.startsWith(refusal.message));
  assert.ok(error.message.endsWith(settings.words.schedule_input_old_engine), error.message);
  assert.equal(calls.length, 1, 'sent once, never without the input');
  assert.ok(calls[0].input);
});
