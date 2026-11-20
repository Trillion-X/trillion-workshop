// tools/list-and-run-my-tools-for-any-ai/test/save-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf, filesAsBytes, descriptorProblems, saveTool, SAVED_TABLE, SaveToolError, MAX_SAVED_BYTES } from '../do-work/save-tool.mjs';

const echo = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', argv: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
};

const fakeClient = () => {
  const calls = [];
  return { calls, query: async (text, values) => { calls.push({ text, values }); return { rows: [], rowCount: 0 }; } };
};

test('a valid echo descriptor has no problems', () => {
  assert.deepEqual(descriptorProblems(echo), []);
});

test('an empty job is refused in plain words', () => {
  assert.ok(descriptorProblems({ ...echo, job: '' }).some(p => p.startsWith('job:')));
});

test('a container without argv is refused', () => {
  assert.ok(descriptorProblems({ ...echo, invoke: { kind: 'container', workdir: '/work' } }).some(p => p.startsWith('invoke.argv:')));
});

test('files must be a path inside the tool', () => {
  assert.throws(() => filesAsBytes({ '../escape.py': 'x' }), SaveToolError);
  assert.throws(() => filesAsBytes({ '/abs.py': 'x' }), SaveToolError);
});

test('the fingerprint is BLAKE3 with the old 1f: prefix', () => {
  assert.match(fingerprintOf(new Uint8Array([1, 2, 3])), /^1f:[0-9a-f]{64}$/);
});

test('a save creates the table, then upserts one row into it', async () => {
  const client = fakeClient();
  const saved = await saveTool({ descriptor: echo, files: { 'main.py': 'print(1)' } }, client);
  assert.equal(saved.table, SAVED_TABLE);
  assert.match(client.calls[0].text, /CREATE TABLE IF NOT EXISTS saved_tools/);
  const upsert = client.calls.find(call => /INSERT INTO saved_tools/.test(call.text));
  assert.ok(upsert, 'the save upserts the row after the table is made');
  assert.equal(upsert.values[0], 'tool:echo-test');
});

test('sending both files and bytes_base64 is refused', async () => {
  await assert.rejects(saveTool({ descriptor: echo, files: { 'a.py': 'x' }, bytes_base64: 'AA==' }, fakeClient()), SaveToolError);
});

test('a refused descriptor writes nothing', async () => {
  const client = fakeClient();
  await assert.rejects(saveTool({ descriptor: { ...echo, job: '' }, files: { 'a.py': 'x' } }, client), SaveToolError);
  assert.equal(client.calls.length, 0);
});

test('a tool just over the 20 MB limit (20 MiB + 1 byte) is refused and writes nothing', async () => {
  const client = fakeClient();
  const bytesBase64 = Buffer.alloc(MAX_SAVED_BYTES + 1).toString('base64');
  await assert.rejects(saveTool({ descriptor: echo, bytes_base64: bytesBase64 }, client), /over 20971520 bytes/);
  assert.equal(client.calls.length, 0);
});

test('a tool exactly at the 20 MB limit (20 MiB = 20971520 bytes) is accepted', async () => {
  const client = fakeClient();
  const saved = await saveTool({ descriptor: echo, bytes_base64: Buffer.alloc(MAX_SAVED_BYTES).toString('base64') }, client);
  assert.equal(saved.bytes, 20971520);
  assert.equal(saved.saved, true);
});
