// test/account-mcp-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { answer, runBridge } from '../harness/account-mcp-bridge.mjs';
import { AccountCallError } from '../harness/account-call.mjs';

const account = { credential: { from: 'kept sign-in', command: ['fake-command'] }, pins: ['f596fa0076f6c620'] };

test('the bridge answers the MCP handshake and lists its one engine tool', async () => {
  const init = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { account });
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const listed = await answer({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { account });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['do_one_thing_in_my_account']);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ['address', 'method', 'input']);
  assert.equal(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }, { account }), null);
});

test('a tool call is answered through the account source, pinned, with the answer as structured content', async () => {
  const seen = [];
  const run = async args => { seen.push(args); return { exit_code: 0, result: { rows: [] } }; };
  const reply = await answer({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: { address: '@tools', method: 'tools:run', input: { tool: 't' }, request_key: 'rk' } } }, { account, run });
  assert.deepEqual(reply.result.structuredContent, { exit_code: 0, result: { rows: [] } });
  assert.equal(seen[0].address, '@tools');
  assert.equal(seen[0].method, 'tools:run');
  assert.equal(seen[0].requestKey, 'rk');
  assert.deepEqual(seen[0].account, account);
});

test('a refused operation is answered as a tool error carrying the engine\'s words', async () => {
  const run = async () => { throw new AccountCallError('The rule does not allow it.', { code: 'refused' }); };
  const reply = await answer({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: { address: '@tools', method: 'tools:run', input: {} } } }, { account, run });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, 'The rule does not allow it.');
});

test('a call with no address is answered as an error by the real operation, which refuses before anything is started', async () => {
  const reply = await answer({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: { method: 'tools:run', input: {} } } }, { account });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /needs an address and a method/);
});

test('other tools and methods are refused by name', async () => {
  const other = await answer({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'take_work', arguments: {} } }, { account });
  assert.equal(other.error.code, -32602);
  const unknown = await answer({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, { account });
  assert.equal(unknown.error.code, -32601);
});

test('the bridge serves messages line by line, and refuses an account that names no pinned computer', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', chunk => lines.push(...chunk.toString().trim().split('\n')));
  const served = runBridge({ account, input, output });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  input.write('not json\n');
  input.end();
  await served;
  await new Promise(done => setImmediate(done));
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(JSON.parse(lines[1]).error.code, -32700);
  await assert.rejects(runBridge({ account: { ...account, pins: [] }, input: new PassThrough(), output: new PassThrough() }), /names no pinned computer/);
});
