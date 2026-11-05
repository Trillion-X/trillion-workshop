// Ported from old trillion test/tool-transaction.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The first seven tests are the old ones over src/tool-transaction.mjs here. The last listed the
// real tools through old src/tools.mjs makeTools and handleMcpMessage (held, not run) and reviewed them with old
// src/mcp-tool-review.mjs toolReviewProblems, which no repository runs (searched makeTools, toolReviewProblems in
// trillion-workshop tools/, trillion-apps web/, trillion-rust src/), so the review is left out. The tool is made by
// src/tool-transaction-tool.mjs over stand-in listed tools, and its description gets its behaviour note as the old listing
// did, from tools/list-tools-for-an-ai/read-data/tool-behavior-notes.mjs.
// test/tool-transaction.test.mjs
//
// Several tool calls made together (src/tool-transaction.mjs, the MCP tool run_tools_together): checked as a whole before anything
// runs, references are paths and never code, the first failure puts back what was done in reverse order, and the real tool list
// carries the tool.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../../shared-code/src/tool-transaction.json' with { type: 'json' };
import { runTransaction } from '../src/tool-transaction.mjs';
import { transactionAnnotations, transactionTools } from '../src/tool-transaction-tool.mjs';
import { withBehaviorNotes } from '../../list-tools-for-an-ai/read-data/tool-behavior-notes.mjs';

const tool = (name, readOnlyHint = false) => ({ name, annotations: { readOnlyHint } });
const tools = [tool('list_things', true), tool('delete_file'), tool('remove_schedule'), tool('make_thing'), tool('send_email'), tool('put_back_file')];

function world(over = {}) {
  const log = [];
  const invoke = async (name, input) => {
    log.push([name, input]);
    if (over[name]) return over[name](input);
    if (name === 'list_things') return { items: [{ id: 'a' }, { id: 'b' }] };
    if (name === 'delete_file') return { set_aside: input.names_or_identities.map((n) => ({ id: `gone:${n}`, label: n })), refused: [] };
    if (name === 'remove_schedule') return { removed: true, put_back: { tool: 'set_schedule', arguments: { schedule_id: input.schedule_id, label: 'x' } } };
    if (name === 'set_schedule' || name === 'put_back_file') return { ok: true };
    return { done: true };
  };
  return { log, invoke };
}

test('a plan that works commits, later steps take values from earlier results, and nothing is put back', async () => {
  const { log, invoke } = world();
  const answer = await runTransaction({ tools, invoke, steps: [
    { id: 'look', tool: 'list_things' },
    { id: 'drop', tool: 'delete_file', input: { names_or_identities: { $from: 'look.result.items[*].id' } } },
    { id: 'send', tool: 'send_email', input: { about: { $from: 'drop.result.set_aside[*].label' } } },
  ] });
  assert.equal(answer.committed, true, JSON.stringify(answer));
  assert.deepEqual(log.map((entry) => entry[0]), ['list_things', 'delete_file', 'send_email']);
  assert.deepEqual(log[1][1], { names_or_identities: ['a', 'b'] });
  assert.deepEqual(log[2][1], { about: ['a', 'b'] });
  assert.deepEqual([answer.undone, answer.not_undone, answer.failed], [[], [], null]);
});

test('a failure puts back the done steps in reverse order, with the tool\'s own undo', async () => {
  const { log, invoke } = world({ send_email: async () => { throw new Error('mail is down'); } });
  const answer = await runTransaction({ tools, invoke, steps: [
    { id: 'drop', tool: 'delete_file', input: { names_or_identities: ['/a.txt', '/b.txt'] } },
    { id: 'stop', tool: 'remove_schedule', input: { schedule_id: 's1' } },
    { id: 'send', tool: 'send_email', input: {} },
  ] });
  assert.equal(answer.committed, false);
  assert.equal(answer.failed.step, 'send');
  assert.match(answer.failed.why, /mail is down/);
  assert.deepEqual(answer.undone, [{ step: 'stop', tool: 'remove_schedule', with: 'set_schedule' }, { step: 'drop', tool: 'delete_file', with: 'put_back_file' }]);
  assert.deepEqual(log.slice(3), [['set_schedule', { schedule_id: 's1', label: 'x' }], ['put_back_file', { ids: ['gone:/a.txt', 'gone:/b.txt'] }]]);
  assert.deepEqual(answer.not_undone, []);
});

test('a result that reports a refusal fails the plan even though the call did not throw, and its partial work is put back', async () => {
  const { log, invoke } = world({ delete_file: async (input) => ({ set_aside: [{ id: 'gone:1' }], refused: [{ name: input.names_or_identities[1], why: 'locked' }] }) });
  const answer = await runTransaction({ tools, invoke, steps: [{ id: 'drop', tool: 'delete_file', input: { names_or_identities: ['/a', '/b'] } }, { id: 'send', tool: 'send_email' }] });
  assert.equal(answer.failed.step, 'drop');
  assert.match(answer.failed.why, /refused/);
  assert.deepEqual(log.map((entry) => entry[0]), ['delete_file', 'put_back_file']);
  assert.deepEqual(log[1][1], { ids: ['gone:1'] });
  assert.deepEqual(answer.undone.map((u) => u.step), ['drop']);
});

test('an undo that fails is reported, and the others are still tried', async () => {
  const { invoke } = world({ put_back_file: async () => { throw new Error('name taken'); }, send_email: async () => ({ error: 'bounced' }) });
  const answer = await runTransaction({ tools, invoke, steps: [
    { id: 'stop', tool: 'remove_schedule', input: { schedule_id: 's1' } },
    { id: 'drop', tool: 'delete_file', input: { names_or_identities: ['/a'] } },
    { id: 'send', tool: 'send_email' },
  ] });
  assert.deepEqual(answer.undone.map((u) => u.step), ['stop']);
  assert.deepEqual(answer.not_undone, [{ step: 'drop', tool: 'delete_file', why: 'name taken' }]);
});

test('a plan is refused whole, before anything runs, when it cannot be put back, names nothing real, or reads from nowhere', async () => {
  const { log, invoke } = world();
  const codes = async (steps) => (await runTransaction({ tools, invoke, steps })).errors.map((error) => error.code);
  assert.deepEqual(await codes([{ id: 'a', tool: 'send_email' }, { id: 'b', tool: 'list_things' }]), ['CANNOT_BE_PUT_BACK']);
  assert.deepEqual(await codes([{ id: 'a', tool: 'ghost' }]), ['UNKNOWN_TOOL']);
  assert.deepEqual(await codes([{ id: 'a', tool: 'list_things' }, { id: 'a', tool: 'list_things' }]), ['DUPLICATE_ID']);
  assert.deepEqual(await codes([{ id: 'a', tool: 'list_things', input: { x: { $from: 'b.result.y' } } }, { id: 'b', tool: 'list_things' }]), ['BAD_REFERENCE']);
  assert.deepEqual(await codes([{ id: 'a', tool: rules.tool_name }]), ['UNKNOWN_TOOL']);
  assert.deepEqual(await codes([]), ['NOT_A_PLAN']);
  assert.deepEqual(await codes(Array.from({ length: rules.limits.steps + 1 }, (_, i) => ({ id: `s${i}`, tool: 'list_things' }))), ['TOO_MANY_STEPS']);
  assert.deepEqual(await codes([{ id: 'a', tool: 'list_things', input: 'x' }]), ['BAD_STEP']);
  assert.deepEqual(log, [], 'nothing ran');
  assert.deepEqual(await codes([{ id: 'a', tool: 'send_email' }]), [], 'the last step may be one that cannot be put back');
});

test('a reference to something an earlier result does not hold fails the plan at that step and puts back what was done', async () => {
  const { log, invoke } = world();
  const answer = await runTransaction({ tools, invoke, steps: [
    { id: 'stop', tool: 'remove_schedule', input: { schedule_id: 's1' } },
    { id: 'drop', tool: 'delete_file', input: { names_or_identities: { $from: 'stop.result.nothing.here' } } },
  ] });
  assert.equal(answer.failed.code, 'REFERENCE_UNRESOLVED');
  assert.deepEqual(answer.undone.map((u) => u.step), ['stop']);
  assert.deepEqual(log.map((entry) => entry[0]), ['remove_schedule', 'set_schedule']);
});

test('a reference is a path read from results; a key that only looks like code is data, and __proto__ reaches nothing', async () => {
  const { log, invoke } = world({ list_things: async () => ({ items: [{ id: 'a' }], note: 'constructor.constructor("return 1")()' }) });
  const fine = await runTransaction({ tools, invoke, steps: [{ id: 'look', tool: 'list_things' }, { id: 'send', tool: 'send_email', input: { said: { $from: 'look.result.note' } } }] });
  assert.equal(fine.committed, true);
  assert.deepEqual(log.at(-1)[1], { said: 'constructor.constructor("return 1")()' });
  log.length = 0;
  const blocked = await runTransaction({ tools, invoke, steps: [{ id: 'look', tool: 'list_things' }, { id: 'send', tool: 'send_email', input: { own: { $from: 'look.result.__proto__' } } }] });
  assert.equal(blocked.failed.code, 'REFERENCE_UNRESOLVED');
  assert.equal(log.length, 1, 'a path through __proto__ is not a result, so the plan stopped before sending');
});

test('the tool list carries run_tools_together, said and hinted as destructive, and it runs the listed tools', async () => {
  const calls = [];
  // Stand-ins for two tools of the list, answering as the old makeTools routes did.
  const call = async (path, body) => { calls.push([path, body]); return path.startsWith('/files') ? { items: [] } : { put_back: { tool: 'set_schedule', arguments: { schedule_id: body?.schedule_id ?? 'x' } }, removed: true }; };
  const real = [
    { name: 'list_schedules', annotations: { readOnlyHint: true }, run: input => call('/files/schedules', input) },
    { name: 'remove_schedule', annotations: { readOnlyHint: false }, run: input => call('/schedules/remove', input) },
    { name: 'set_schedule', annotations: { readOnlyHint: false }, run: input => call('/schedules/set', input) },
  ];
  const listed = [...real, ...transactionTools(real).map(item => withBehaviorNotes({ ...item, annotations: transactionAnnotations[item.name] }))];
  const plan = listed.find((item) => item.name === rules.tool_name);
  assert.ok(plan && plan.annotations.destructiveHint === true);
  assert.match(plan.description, /confirm with the person/i);
  const answer = await plan.run({ steps: [{ id: 'list', tool: 'list_schedules' }, { id: 'stop', tool: 'remove_schedule', input: { schedule_id: 's9' } }] });
  assert.equal(answer.committed, true, JSON.stringify(answer));
  assert.ok(calls.length >= 2);
});
