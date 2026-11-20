// tools/workspace-screens/test/account-door-pins.test.mjs
//
// The account door (web/src/workspace/account-door.ts) carries a computer named in a door address as the tools/call
// argument `pins` (the engine's CALL_FIELDS), and sends no pin when none is named, as it always did. A refusal keeps the
// engine's code as `refused.code`, where api.ts's readJson reads it. Built the way account-pass-quiet.test.mjs builds
// its module: the file is transformed as TypeScript and its two imports are stood in for.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../web/src/workspace/account-door.ts', import.meta.url), 'utf8');
const door = JSON.parse(await readFile(new URL('../web/src/workspace/account-door.json', import.meta.url), 'utf8'));
const stood = source
  .replace(/^import door from .*$/m, `const door = ${JSON.stringify(door)};`)
  .replace(/^import \{ pass, passRefused \} from .*$/m, 'const pass = async () => "pass-1"; const passRefused = () => {};');
const { code } = await transform(stood, { loader: 'ts', format: 'esm' });
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${Math.random()}`).toString('base64')}`);

const ORIGIN = 'https://door.example.test';
globalThis.location = { origin: ORIGIN, pathname: '/workspace', search: '' };

// The door's tools/call is answered as one JSON-RPC result; the test reads back the arguments it was sent.
function answering(result) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };
  return sent;
}

// The door's timer is kept as a stop for its own answer; these tests never wait on it.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;
after(() => { globalThis.setTimeout = realSetTimeout; });

test('a door address with no computer named sends no pin, as it always did', async () => {
  const { callOf } = await load();
  const call = callOf(`${ORIGIN}/work/api/door/sharing.list`, {});
  assert.deepEqual(call, { method: 'sharing.list', request_key: call.request_key, input: {} });
  assert.equal('pins' in call, false);
});

test('a computer named in the address is sent as pins: [id], with the method and the body as before', async () => {
  const { callOf } = await load();
  const input = { label: 'Sam', on: true, sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: [] } };
  const call = callOf(`${ORIGIN}/work/api/door/sharing.keep?computer=computer-7`, { method: 'POST', body: JSON.stringify(input), headers: { 'idempotency-key': 'key-9' } });
  assert.deepEqual(call, { method: 'sharing.keep', request_key: 'key-9', input, pins: ['computer-7'] });
});

test('a door address that is not the door form is no call at all', async () => {
  const { callOf } = await load();
  assert.equal(callOf(`${ORIGIN}/work/api/records?computer=x`, {}), null);
});

test('answerAtTheDoor puts the pin in the tools/call arguments, and only when one is named', async () => {
  const { answerAtTheDoor } = await load();
  const sent = answering({ structuredContent: { grants: [] } });
  await answerAtTheDoor(`${ORIGIN}/work/api/door/sharing.list?computer=computer-7`, {});
  await answerAtTheDoor(`${ORIGIN}/work/api/door/sharing.list`, {});
  assert.equal(sent[0].url, '/mcp', 'the door route, as the page asks it');
  assert.equal(sent[0].body.method, 'tools/call');
  assert.equal(sent[0].body.params.name, door.tool);
  assert.deepEqual(sent[0].body.params.arguments.pins, ['computer-7']);
  assert.equal('pins' in sent[1].body.params.arguments, false);
});

test('a refusal keeps the engine code as refused.code beside its words', async () => {
  const { answerAtTheDoor } = await load();
  answering({ isError: true, structuredContent: { code: 'current_workspace_rights_refused', cause: 'x' }, content: [{ type: 'text', text: 'refused' }] });
  const answer = await answerAtTheDoor(`${ORIGIN}/work/api/door/sharing.keep?computer=computer-7`, { method: 'POST', body: '{}' });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.refused.code, 'current_workspace_rights_refused');
  assert.equal(answer.body.error, 'refused');
});
