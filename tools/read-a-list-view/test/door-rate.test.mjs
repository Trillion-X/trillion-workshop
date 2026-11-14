// The door (read-data/door.mjs) over HTTP to a stand-in records door that counts a key's calls: a call over the rate
// (sign_in_too_many_calls) is sent again after the wait the door names, with the same request key, and answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDoor } from '../read-data/door.mjs';

const CONFIG = port => ({ transport: { url: `http://127.0.0.1:${port}/mcp`, credential: { keychain_item: 'made-up' } },
  records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' },
  tools: { address: '@workshop-tools', run_method: 'tools:run' } });

test('a call over the key\'s rate waits the time the door names and is sent again with the same request key', async () => {
  const keys = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      keys.push(call.params.arguments.request_key);
      const result = keys.length === 1
        ? { isError: true, structuredContent: { code: 'sign_in_too_many_calls', detail: { retry_after_seconds: 0.2 }, outcome: 'not_started' } }
        : { structuredContent: { id: 'record:loaf:rye', value: { name: 'Rye' } } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const door = await openDoor(CONFIG(server.address().port), { keyOf: async () => 'made-up-key-for-the-bakery' });
    const started = Date.now();
    assert.deepEqual(await door.read('record:loaf', 'record:loaf:rye'), { name: 'Rye' });
    assert.ok(Date.now() - started >= 200, 'the wait the door named was kept');
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally { server.close(); }
});

test('a write the door refused for running past its time before it started is sent again with the same request key and lands', async () => {
  const keys = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      keys.push(call.params.arguments.request_key);
      const result = keys.length < 3
        ? { isError: true, structuredContent: { code: 'write_deadline_exceeded', outcome: 'not_started' } }
        : { structuredContent: { changed: true, write_count: 1 } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const door = await openDoor({ ...CONFIG(server.address().port), records: { ...CONFIG(0).records, write_method: 'records:write' } }, { keyOf: async () => 'made-up-key-for-the-bakery' });
    assert.deepEqual(await door.write([{ id: 'record:loaf:rye', type: 'record:loaf', value: { name: 'Rye' } }], { key: 'refresh:loaves:documents:1:0' }), { changed: true, write_count: 1 });
    assert.deepEqual(keys, ['refresh:loaves:documents:1:0', 'refresh:loaves:documents:1:0', 'refresh:loaves:documents:1:0']);
  } finally { server.close(); }
});

test('a write refused as over its time but possibly started is not sent again as a new write', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: true, structuredContent: { code: 'write_deadline_exceeded', outcome: 'committed' } } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const door = await openDoor({ ...CONFIG(server.address().port), records: { ...CONFIG(0).records, write_method: 'records:write' } }, { keyOf: async () => 'made-up-key-for-the-bakery' });
    await assert.rejects(door.write([{ id: 'record:loaf:rye', type: 'record:loaf', value: {} }], { key: 'k' }), /write_deadline_exceeded/);
  } finally { server.close(); }
});

test('a write refused because the store was busy and never started is sent again with the same request key', async () => {
  const keys = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      keys.push(call.params.arguments.request_key);
      const result = keys.length < 2
        ? { isError: true, structuredContent: { code: 'original_workspace_source_unavailable', outcome: 'not_started' } }
        : { structuredContent: { changed: true, write_count: 1 } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const door = await openDoor({ ...CONFIG(server.address().port), records: { ...CONFIG(0).records, write_method: 'records:write' } }, { keyOf: async () => 'made-up-key-for-the-bakery' });
    assert.deepEqual(await door.write([{ id: 'record:loaf:rye', type: 'record:loaf', value: {} }], { key: 'k2' }), { changed: true, write_count: 1 });
    assert.deepEqual(keys, ['k2', 'k2']);
  } finally { server.close(); }
});
