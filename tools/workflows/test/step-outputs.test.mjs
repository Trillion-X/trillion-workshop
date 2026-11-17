// tools/workflows: a step's `outputs` say where its answer's fields go. The cart lines, the stores and the tools that write
// are made up here; nothing below is a real person's line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { recipeFromRows } from '../read-data/recipe-rows.mjs';
import { keepStepOutputs, parseStepOutputs, stepOutputsProblems } from '../read-data/step-outputs.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';

const run = 'ai-job:workflow:made-up-keep:k1';
const line = (id, kind) => ({ id: `record:cart-line:${id}`, value: { kind, store: `store-of-${id}`, credential_name: `cred-of-${id}` } });

function memoryDoor(steps, lines = []) {
  const held = new Map([[run, { id: run, value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-keep', label: 'Made-up keep', job: steps, input: {} } }]]);
  return {
    held,
    read: async (_kind, id) => held.get(id)?.value ?? null,
    async *list({ type }) { if (type === 'record:cart-line') yield* lines; },
    write: async records => { for (const record of records) held.set(record.id, record); },
  };
}
const fakeTools = () => { const calls = []; return { calls, run: async (tool, input, key) => { calls.push({ tool, input, key }); return { ok: true }; } }; };
const stepWith = outputs => ({ id: 'make', title: 'Make', do: 'Make it.', submit: { type: 'object' }, outputs });
const submit = (door, tools, key = 's1') => submitARecipeStep({ input: { run, step: 'make', answer: { result: 'the loaf', note: 'x' } }, task: { request_key: key } }, { door, tools });

test('a step row\'s outputs are read back like its other JSON text', () => {
  const outputs = [{ port: 'result', kind: 'file' }, { port: 'note', kind: 'row:notes' }];
  const row = { value: { recipe: 'workflow:made-up', title: 'Made up', job: 'Do it.' } };
  const step = { value: { recipe: ['made-up'], position: 1, step: 'make', title: 'Make', do: 'Make it.', submit: '{"type":"object"}', outputs: JSON.stringify(outputs) } };
  assert.deepEqual(recipeFromRows(row, [step]).steps[0].outputs, outputs);
});

test('a malformed outputs is refused with a message that says which part', () => {
  const bad = [
    [[{ port: 'a', kind: 'folder' }], /kind must be/],
    [[{ port: 'a', kind: 'row:' }], /kind must be/],
    [[{ port: 'a b', kind: 'file' }], /port must name/],
    [[{ port: 'a', kind: 'file' }, { port: 'a', kind: 'none' }], /named twice/],
    [[{ port: 'a', kind: 'file', store: 'x' }], /not a field/],
    [[], /non-empty list/],
    ['file', /non-empty list/],
  ];
  for (const [outputs, message] of bad) assert.match(stepOutputsProblems(outputs, 'step').join(' '), message);
  assert.throws(() => parseStepOutputs([{ port: 'a', kind: 'bucket' }], 'Step "x"'), /Step "x".*kind must be/);
  const row = { value: { recipe: 'workflow:made-up', title: 'Made up', job: 'Do it.' } };
  const step = { value: { recipe: ['made-up'], position: 1, step: 'make', do: 'Make it.', submit: '{"type":"object"}', outputs: '[{"port":"a","kind":"bucket"}]' } };
  assert.throws(() => recipeFromRows(row, [step]), /kind must be/);
  assert.deepEqual(stepOutputsProblems([{ port: 'a', kind: 'row:made-up-list' }, { port: 'b', kind: 'none' }]), []);
});

test('kind none returns the value, keeps nothing and calls no tool', async () => {
  const tools = fakeTools();
  const door = memoryDoor([stepWith([{ port: 'result', kind: 'none' }])], [line('a', 'file')]);
  const answered = await submit(door, tools);
  assert.deepEqual(answered.outputs.map(({ port, kind, kept, value }) => ({ port, kind, kept, value })), [{ port: 'result', kind: 'none', kept: false, value: 'the loaf' }]);
  assert.match(answered.outputs[0].said, /kept nowhere/);
  assert.equal(tools.calls.length, 0);
});

test('a kind with no cart line returns the value, keeps nothing, says so, and the answer is still kept', async () => {
  const tools = fakeTools();
  const door = memoryDoor([stepWith([{ port: 'result', kind: 'file' }, { port: 'note', kind: 'row:notes' }])], [line('a', 'row:other')]);
  const answered = await submit(door, tools);
  assert.equal(answered.status, 'kept');
  assert.deepEqual(answered.outputs.map(output => output.kept), [false, false]);
  assert.match(answered.outputs[0].said, /no cart line for file/);
  assert.match(answered.outputs[1].said, /no cart line for row:notes/);
  assert.equal(tools.calls.length, 0);
});

test('a file goes through the file tool with the person\'s line, and a row through the sql tool', async () => {
  const tools = fakeTools();
  const door = memoryDoor([stepWith([{ port: 'result', kind: 'file' }, { port: 'note', kind: 'row:notes' }])], [line('f', 'file'), line('r', 'row:*')]);
  const answered = await submit(door, tools);
  assert.deepEqual(answered.outputs.map(output => output.kept), [true, true]);
  assert.deepEqual(tools.calls, [
    { tool: 'tool:send-a-file-to-a-namespace', input: { store: 'store-of-f', credential_name: 'cred-of-f', name: `${run}:make:result`, content: 'the loaf' }, key: `${run}:make:result:output` },
    { tool: 'tool:run-sql-in-my-database', input: { store: 'store-of-r', credential_name: 'cred-of-r', list: 'notes', id: `${run}:make:note`, value: 'x' }, key: `${run}:make:note:output` },
  ]);
  assert.ok(door.held.has(`${run}#answer:make`));
});

test('a line of the exact list wins over the any-list line, and a cart line with no tool runner keeps nothing', async () => {
  const door = memoryDoor([], [line('any', 'row:*'), line('own', 'row:notes')]);
  const tools = fakeTools();
  await keepStepOutputs({ outputs: [{ port: 'note', kind: 'row:notes' }], answer: { note: 1 }, run, step: 'make' }, { door, tools });
  assert.equal(tools.calls[0].input.store, 'store-of-own');
  const none = await keepStepOutputs({ outputs: [{ port: 'note', kind: 'row:notes' }], answer: { note: 1 }, run, step: 'make' }, { door });
  assert.equal(none[0].kept, false);
  assert.match(none[0].said, /no tool runner/);
});

test('a refused write leaves the step open, and a retry with the same keys writes again under the same request keys', async () => {
  const door = memoryDoor([stepWith([{ port: 'result', kind: 'file' }])], [line('f', 'file')]);
  const tools = { calls: [], run: async () => { throw new Error('the store refused'); } };
  await assert.rejects(submit(door, tools), /store refused/);
  assert.equal(door.held.has(`${run}#answer:make`), false);
  const good = fakeTools();
  assert.equal((await submit(door, good, 's2')).status, 'kept');
  assert.equal(good.calls[0].key, `${run}:make:result:output`);
});
